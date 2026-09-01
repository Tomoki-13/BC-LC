// index.d.ts（ライブラリ同梱の型定義）で surface 抽出の妥当性を検証する
// ライブラリが型定義を持つ版のみ、宣言 export 名の何%を surface が捕捉できたか（coverage / missing）を返す
import fs from 'fs';
import path from 'path';
import type { ApiSymbol, DtsValidation } from '../types/LibDiff';
import { createAstFromFile } from '../astRelated/base/createAstFromFile';

// 型のみ export（ランタイムに無いので coverage の分母から除く）の宣言ノード種別
const TYPE_DECLS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration']);

// export 宣言ノードから宣言される名前を取り出す
function declaredNames(decl: any): string[] {
  if (!decl) return [];
  if (decl.type === 'VariableDeclaration') return (decl.declarations ?? []).map((d: any) => d.id?.name).filter(Boolean);
  return decl.id?.name ? [decl.id.name] : [];
}
const specifierName = (spec: any): string | null =>
  spec.exported?.type === 'Identifier' ? spec.exported.name
    : spec.exported?.type === 'StringLiteral' ? spec.exported.value : null;

// .d.ts の export 名を「値」と「型のみ」に分けて抽出（Babel AST・typescript プラグイン）
// 型のみ export（interface/type/enum/namespace）はランタイムに無いので coverage の分母から除く
function parseDtsExports(dtsPath: string, content: string): { value: Set<string>; type: Set<string> } {
  const value = new Set<string>();
  const type = new Set<string>();
  const ast = createAstFromFile(dtsPath, content); // .d.ts は拡張子 .ts 判定で typescript プラグインが付く
  if (!ast) return { value, type };

  for (const node of (ast.program.body as any[])) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const bucket = TYPE_DECLS.has(node.declaration.type) ? type : value; // function/const/class/TSDeclareFunction は値
        for (const n of declaredNames(node.declaration)) bucket.add(n);
      }
      for (const spec of (node.specifiers ?? [])) {                           // export { A, B as C } / export type { ... }
        const n = specifierName(spec);
        if (!n) continue;
        (node.exportKind === 'type' || spec.exportKind === 'type' ? type : value).add(n);
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      value.add('default');
    } else if (node.type === 'TSExportAssignment' && node.expression?.type === 'Identifier') {
      value.add(node.expression.name);                                        // export = Foo（CJS）
    }
  }
  return { value, type };
}

/**
 * 版ツリーの .d.ts（package.json types/typings → index.d.ts の順）で surface 抽出の妥当性を検証
 * 入力: 版ツリー / その版の抽出済み symbols
 * 出力: DtsValidation（型定義が無ければ hasDts:false）
 */
export function validateAgainstDts(treeDir: string, symbols: ApiSymbol[]): DtsValidation {
  let dtsRel: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf-8'));
    const t = pkg?.types || pkg?.typings;
    if (typeof t === 'string') { const p = t.endsWith('.d.ts') ? t : `${t}.d.ts`; if (fs.existsSync(path.join(treeDir, p))) dtsRel = p; }
  } catch { /* package.json 無し等はスキップ */ }
  if (!dtsRel && fs.existsSync(path.join(treeDir, 'index.d.ts'))) dtsRel = 'index.d.ts';
  if (!dtsRel) return { hasDts: false };

  let content: string;
  try { content = fs.readFileSync(path.join(treeDir, dtsRel), 'utf-8'); } catch { return { hasDts: false }; }
  const { value, type } = parseDtsExports(dtsRel, content);
  if (value.size === 0) return { hasDts: true, dtsFile: dtsRel, dtsExportCount: 0, typeExportCount: type.size, matchedCount: 0, coverage: 1, missing: [] };
  const surfaceNames = new Set(symbols.map(s => s.name));
  const missing = [...value].filter(n => !surfaceNames.has(n));
  const matchedCount = value.size - missing.length;
  return { hasDts: true, dtsFile: dtsRel, dtsExportCount: value.size, typeExportCount: type.size, matchedCount, coverage: +(matchedCount / value.size).toFixed(3), missing };
}
