import { promises as fs } from 'fs';
import traverseImport from '@babel/traverse';
import * as t from '@babel/types';
import { createAstFromFile } from '../base/createAstFromFile';
import type { ExportStyle } from '../../types/LibDiff';

const traverse = ((traverseImport as any).default ?? traverseImport) as typeof traverseImport;

/** 相対パスのファイルから読み込んだものをそのまま公開しているときの出どころ（spec=指定子・imported=読み込み先での名前） */
export interface ReexportOrigin {
  spec: string;      // 例 './v1'
  imported: string;  // 'default'（require('./x') / import x from './x'）か名前（require('./x').foo / export { foo } from './x'）
}

/** 公開 export 名 1件（値の種類を問わない。名前と公開形のみ） */
export interface ExportedName {
  name: string;
  exportStyle: ExportStyle;
  from?: ReexportOrigin;  // 相対パスの読み込みをそのまま公開しているときだけ
}

/**
 * getFunction のサポート用：ソースから「公開 export の名前」を値の種類を問わず集める（関数だけでなく変数・値・object メンバも）
 *   CJS  module.exports = { VERSION: '1.0.0', config: {...} }   → VERSION, config
 *   CJS  module.exports.MAX = 100                               → MAX
 *   CJS  exports.table = {...}                                  → table
 *   CJS  var he = { encode:fn, DELIM:',' }; module.exports = he → encode, DELIM（識別子経由のobject公開）
 *   ESM  export const VERSION = '1.0.0'                         → VERSION
 *   ESM  export let table = {...}                              → table
 *   ESM  export { NAMES }                                       → NAMES
 *   ESM  export default 42                                      → default
 *
 * さらに「公開実体の静的プロパティ」も拾う（クライアントが lib.PROP で触れるもの）:
 *   CJS  function Big(){}; Big.version='5'; module.exports = 〇〇
 *   ESM  export class C { static create(){} static MAX=1 } 
 */
export const getExportedNames = async (filePath: string): Promise<ExportedName[]> => {
  if (!filePath.match(/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/)) return [];
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const parsed = createAstFromFile(filePath, content);
  if (!parsed) return [];

  const found = new Map<string, ExportStyle>();
  const origins = new Map<string, ReexportOrigin>();
  const add = (name: string, style: ExportStyle, from?: ReexportOrigin) => {
    if (found.has(name)) return;
    found.set(name, style);
    if (from) origins.set(name, from);
  };

  // クラス本体の static メンバ名（static method / static property）を集める
  const classStaticMembers = (classNode: any): string[] => {
    const names: string[] = [];
    for (const m of classNode.body?.body ?? []) {
      if (m.static && !m.computed && t.isIdentifier(m.key)
        && (t.isClassMethod(m) || t.isClassProperty(m))) names.push(m.key.name);
    }
    return names;
  };

  const isExportsId = (node: any) => t.isIdentifier(node, { name: 'exports' });
  const isModuleExports = (node: any) =>
    t.isMemberExpression(node) && !node.computed
    && t.isIdentifier(node.object, { name: 'module' }) && t.isIdentifier(node.property, { name: 'exports' });

  // pass1: 解決用の情報を収集
  //   objectLiteralVars: `const X = {…}` の名前→キー（module.exports = X の解決用）
  //   exportRoots: 公開実体の識別子（module.exports = Id / export default Id / export [default] class Named）
  //   staticAssigns: `Id.prop = <何でも>` の静的代入（obj が公開実体なら公開静的プロパティ）
  //   classStatics: クラス名→static メンバ名
  const objectLiteralVars = new Map<string, any>();
  // 出どころをたどる用: 変数名 → 初期化式 / import した名前 → 出どころ
  const varInits = new Map<string, any>();
  const importOrigins = new Map<string, ReexportOrigin>();
  const exportRoots = new Set<string>();
  const staticAssigns: { obj: string; prop: string; right: any }[] = [];
  const classStatics = new Map<string, string[]>();
  try {
    traverse(parsed, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (t.isIdentifier(id) && init && t.isObjectExpression(init)) objectLiteralVars.set(id.name, init);
        if (t.isIdentifier(id) && init) varInits.set(id.name, init);
        if (t.isIdentifier(id) && init && t.isClassExpression(init)) classStatics.set(id.name, classStaticMembers(init));
      },
      ClassDeclaration(path) {
        if (path.node.id) classStatics.set(path.node.id.name, classStaticMembers(path.node));
      },
      ImportDeclaration(path) {
        const spec = path.node.source.value;
        if (!spec.startsWith('.')) return;
        for (const sp of path.node.specifiers) {
          if (t.isImportDefaultSpecifier(sp)) importOrigins.set(sp.local.name, { spec, imported: 'default' });
          else if (t.isImportSpecifier(sp)) {
            const imported = t.isIdentifier(sp.imported) ? sp.imported.name : sp.imported.value;
            importOrigins.set(sp.local.name, { spec, imported });
          }
        }
      },
      ExportDefaultDeclaration(path) {
        const d: any = path.node.declaration;
        if (t.isIdentifier(d)) exportRoots.add(d.name);
        else if ((t.isClassDeclaration(d) || t.isFunctionDeclaration(d)) && d.id) exportRoots.add(d.id.name);
        if (t.isClassDeclaration(d) && d.id) classStatics.set(d.id.name, classStaticMembers(d));
      },
      ExportNamedDeclaration(path) {
        const d = path.node.declaration;
        if (t.isClassDeclaration(d) && d.id) exportRoots.add(d.id.name);
      },
      AssignmentExpression(path) {
        const { left, right } = path.node;
        if ((isExportsId(left) || isModuleExports(left)) && t.isIdentifier(right)) exportRoots.add(right.name);
        // Id.prop = <何でも>（module/exports 以外のオブジェクトへの静的代入。prototype 経由は object が非 Identifier なので除外される）
        if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.object) && t.isIdentifier(left.property)
          && left.object.name !== 'module' && left.object.name !== 'exports') {
          staticAssigns.push({ obj: left.object.name, prop: left.property.name, right });
        }
      },
    });
  } catch { /* 壊れた断片は無視 */ }

  // 式が相対パスの読み込みをそのまま指すときの出どころ
  //   require('./x') → default / require('./x').foo → foo / 識別子は初期化式・import をたどる（var uuid = v4 のような別名も）
  const originOf = (node: any, depth = 0): ReexportOrigin | undefined => {
    if (!node || depth > 5) return undefined;
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'require' })
      && node.arguments.length === 1 && t.isStringLiteral(node.arguments[0]) && node.arguments[0].value.startsWith('.')) {
      return { spec: node.arguments[0].value, imported: 'default' };
    }
    if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
      const base = originOf(node.object, depth + 1);
      return base && base.imported === 'default' ? { spec: base.spec, imported: node.property.name } : undefined;
    }
    if (t.isIdentifier(node)) {
      return importOrigins.get(node.name) ?? originOf(varInits.get(node.name), depth + 1);
    }
    // module.exports = exports = require('./promise')（連鎖代入は右辺）
    if (t.isAssignmentExpression(node)) return originOf(node.right, depth + 1);
    return undefined;
  };

  // オブジェクトリテラルの公開キー名と値（{ v1: require('./v1') } / { v1 } の出どころ用）
  const objectEntries = (objNode: any): { key: string; value: any }[] => {
    const out: { key: string; value: any }[] = [];
    for (const prop of objNode.properties ?? []) {
      if ((t.isObjectProperty(prop) || t.isObjectMethod(prop)) && !prop.computed) {
        const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : undefined;
        if (key !== undefined) out.push({ key, value: t.isObjectProperty(prop) ? prop.value : undefined });
      }
    }
    return out;
  };

  // pass2: 各 export サイトから公開名を集める
  try {
    traverse(parsed, {
      // ESM: export const/let/var / function / class / 名前付き / 再エクスポート
      ExportNamedDeclaration(path) {
        const style: ExportStyle = path.node.source ? 'esm-reexport' : 'esm-named';
        const decl = path.node.declaration;
        if (t.isVariableDeclaration(decl)) {
          for (const d of decl.declarations) if (t.isIdentifier(d.id)) add(d.id.name, 'esm-named');
        } else if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) {
          add(decl.id.name, 'esm-named');
        }
        const source = path.node.source?.value;
        for (const spec of path.node.specifiers) {
          if (!t.isExportSpecifier(spec) || !t.isIdentifier(spec.exported)) continue;
          const local = t.isIdentifier(spec.local) ? spec.local.name : (spec.local as any).value;
          // export { default as v1 } from './v1.js' → v1 は ./v1.js の default / export { v1 } → v1 の import・初期化式
          const from = source !== undefined
            ? (source.startsWith('.') ? { spec: source, imported: local } : undefined)
            : originOf(t.identifier(local));
          add(spec.exported.name, style, from);
        }
      },

      // ESM: export default <任意>
      ExportDefaultDeclaration(path) {
        const d: any = path.node.declaration;
        add('default', 'esm-default', t.isIdentifier(d) ? originOf(d) : undefined);
      },

      // CJS: module.exports / exports への代入
      AssignmentExpression(path) {
        const { left, right } = path.node;
        const toExports = isExportsId(left) || isModuleExports(left);

        // module.exports = { ... } / = <object変数> / = <値>
        if (toExports) {
          if (t.isObjectExpression(right)) {
            for (const e of objectEntries(right)) add(e.key, 'cjs-property', originOf(e.value));
          } else if (t.isIdentifier(right) && objectLiteralVars.has(right.name)) {
            for (const e of objectEntries(objectLiteralVars.get(right.name))) add(e.key, 'cjs-property', originOf(e.value));
          } else {
            add('default', 'cjs-module-default', originOf(right)); // 値/関数/クラスの直接 default 公開
          }
          return;
        }

        // module.exports.X = ... / exports.X = ...
        if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.property)) {
          const base = left.object;
          if (isExportsId(base) || isModuleExports(base)) add(left.property.name, 'cjs-property', originOf(right));
        }
      },
    });
  } catch { /* 壊れた断片は無視 */ }

  // 公開実体の静的プロパティを追加（クライアントが lib.PROP で触れる名前）。prototype は実装詳細なので除外
  for (const { obj, prop, right } of staticAssigns) {
    // 例: module.exports=Big; Big.version=... → version / module.exports=uuid; uuid.v1 = require('./v1') → v1（./v1 の default）
    if (exportRoots.has(obj) && prop !== 'prototype') add(prop, 'cjs-property', originOf(right));
  }
  for (const [cls, members] of classStatics) {
    if (exportRoots.has(cls)) for (const m of members) add(m, 'esm-named'); // 例: export class C { static create }
  }

  return [...found].map(([name, exportStyle]) => (origins.has(name)
    ? { name, exportStyle, from: origins.get(name) }
    : { name, exportStyle }));
};
