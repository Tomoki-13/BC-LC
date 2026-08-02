import { promises as fs } from 'fs';
import traverseImport from '@babel/traverse';
import * as t from '@babel/types';
import { createAstFromFile } from '../base/createAstFromFile';
import type { ExportStyle } from '../../types/LibDiff';

const traverse = ((traverseImport as any).default ?? traverseImport) as typeof traverseImport;

/** 公開 export 名 1件（値の種類を問わない。名前と公開形のみ） */
export interface ExportedName {
  name: string;
  exportStyle: ExportStyle;
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
  const add = (name: string, style: ExportStyle) => { if (!found.has(name)) found.set(name, style); };

  // オブジェクトリテラルの公開可能なキー名（ObjectProperty / ObjectMethod・非 computed のみ）
  const objectKeys = (objNode: any): string[] => {
    const keys: string[] = [];
    for (const prop of objNode.properties ?? []) {
      if ((t.isObjectProperty(prop) || t.isObjectMethod(prop)) && !prop.computed) {
        if (t.isIdentifier(prop.key)) keys.push(prop.key.name);
        else if (t.isStringLiteral(prop.key)) keys.push(prop.key.value);
      }
    }
    return keys;
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
  const objectLiteralVars = new Map<string, string[]>();
  const exportRoots = new Set<string>();
  const staticAssigns: { obj: string; prop: string }[] = [];
  const classStatics = new Map<string, string[]>();
  try {
    traverse(parsed, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (t.isIdentifier(id) && init && t.isObjectExpression(init)) objectLiteralVars.set(id.name, objectKeys(init));
        if (t.isIdentifier(id) && init && t.isClassExpression(init)) classStatics.set(id.name, classStaticMembers(init));
      },
      ClassDeclaration(path) {
        if (path.node.id) classStatics.set(path.node.id.name, classStaticMembers(path.node));
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
          staticAssigns.push({ obj: left.object.name, prop: left.property.name });
        }
      },
    });
  } catch { /* 壊れた断片は無視 */ }

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
        for (const spec of path.node.specifiers) {
          if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported)) add(spec.exported.name, style);
        }
      },

      // ESM: export default <任意>
      ExportDefaultDeclaration() {
        add('default', 'esm-default');
      },

      // CJS: module.exports / exports への代入
      AssignmentExpression(path) {
        const { left, right } = path.node;
        const toExports = isExportsId(left) || isModuleExports(left);

        // module.exports = { ... } / = <object変数> / = <値>
        if (toExports) {
          if (t.isObjectExpression(right)) {
            for (const k of objectKeys(right)) add(k, 'cjs-property');
          } else if (t.isIdentifier(right) && objectLiteralVars.has(right.name)) {
            for (const k of objectLiteralVars.get(right.name)!) add(k, 'cjs-property');
          } else {
            add('default', 'cjs-module-default'); // 値/関数/クラスの直接 default 公開
          }
          return;
        }

        // module.exports.X = ... / exports.X = ...
        if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.property)) {
          const base = left.object;
          if (isExportsId(base) || isModuleExports(base)) add(left.property.name, 'cjs-property');
        }
      },
    });
  } catch { /* 壊れた断片は無視 */ }

  // 公開実体の静的プロパティを追加（クライアントが lib.PROP で触れる名前）。prototype は実装詳細なので除外
  for (const { obj, prop } of staticAssigns) {
    if (exportRoots.has(obj) && prop !== 'prototype') add(prop, 'cjs-property'); // 例: module.exports=Big; Big.version=... → version
  }
  for (const [cls, members] of classStatics) {
    if (exportRoots.has(cls)) for (const m of members) add(m, 'esm-named'); // 例: export class C { static create }
  }

  return [...found].map(([name, exportStyle]) => ({ name, exportStyle }));
};
