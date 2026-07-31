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
 * ソースから「公開 export の名前」を値の種類を問わず集める（関数だけでなく変数・値・object メンバも）
 *   getFunction が関数/アロー/クラスの export しか拾わないため、それが取りこぼす非関数 export 名を補う。
 *   名前と公開形(exportStyle)のみを返す（値の中身・シグネチャは見ない＝表面レベル）。
 *
 * 新たに取れるようになる例（従来は欠落 → クライアントの参照が消えても検出できなかった）:
 *   CJS  module.exports = { VERSION: '1.0.0', config: {...} }   → VERSION, config
 *   CJS  module.exports.MAX = 100                               → MAX
 *   CJS  exports.table = {...}                                  → table
 *   CJS  var he = { encode:fn, DELIM:',' }; module.exports = he → encode, DELIM（識別子経由のobject公開）
 *   ESM  export const VERSION = '1.0.0'                         → VERSION
 *   ESM  export let table = {...}                              → table
 *   ESM  export { NAMES }                                       → NAMES
 *   ESM  export default 42                                      → default
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

  // pass1: `const X = { ... }` の object リテラルを名前→キー で控える（module.exports = X の解決用）
  const objectLiteralVars = new Map<string, string[]>();
  try {
    traverse(parsed, {
      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.id) && path.node.init && t.isObjectExpression(path.node.init)) {
          objectLiteralVars.set(path.node.id.name, objectKeys(path.node.init));
        }
      },
    });
  } catch { /* 壊れた断片は無視 */ }

  const isExportsId = (node: any) => t.isIdentifier(node, { name: 'exports' });
  const isModuleExports = (node: any) =>
    t.isMemberExpression(node) && !node.computed
    && t.isIdentifier(node.object, { name: 'module' }) && t.isIdentifier(node.property, { name: 'exports' });

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

  return [...found].map(([name, exportStyle]) => ({ name, exportStyle }));
};
