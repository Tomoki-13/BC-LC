import fs from 'fs';
import path from 'path';
import traverseImport from '@babel/traverse';
import { getAllFiles } from '../utils/getAllFiles';
import { getFunction } from '../analyzer/astRelated/trace/getFunction';
import { createAstFromFile } from '../analyzer/astRelated/base/createAstFromFile';
import type { ApiSymbol, ApiSurface } from '../types/LibDiff';

// ESM 経由だと default が { default: fn } になりうるため callable を取り出す
const traverse = ((traverseImport as any).default ?? traverseImport) as typeof traverseImport;

const SOURCE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

/** ツリー配下の解析対象ソースを列挙（除外方針は getAllFiles に準拠） */
async function listSourceFiles(treeDir: string): Promise<string[]> {
  const files = await getAllFiles(treeDir);
  return files.filter(f => SOURCE_EXT.includes(path.extname(f)));
}

/**
 * 関数ノードの開始位置 → async か のマップ（JS 構文のみ。型情報は使わない）
 * getFunction が記録する start（関数ノードの start）と突き合わせて async を後付けする
 * TODO: getFunction が二重 parse になっている（将来 getFunction 側で async を返せば不要）
 */
function asyncByStart(filePath: string): Map<number, boolean> {
  const m = new Map<number, boolean>();
  try {
    const ast = createAstFromFile(filePath, fs.readFileSync(filePath, 'utf-8'));
    if (!ast) return m;
    traverse(ast, {
      enter(path: any) {
        const n = path.node;
        if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
          || n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod') && n.start != null) {
          m.set(n.start, !!n.async);
        }
      },
    });
  } catch {
    /* parse 失敗時は空 */
  }
  return m;
}

/** 1 ファイルの export 関数を ApiSymbol[] へ（getFunction mode 0 を再利用） */
async function extractExports(filePath: string, treeDir: string): Promise<ApiSymbol[]> {
  const funcs = await getFunction(filePath, 0); // mode 0 = export 関数のみ
  const asyncMap = asyncByStart(filePath);
  const rel = path.relative(treeDir, filePath);
  return funcs.map(f => ({
    name: f.name,
    kind: 'function',          // TODO: class/value/getter の判別（getFunction 出力に種別情報なし）
    exportStyle: 'unknown',    // TODO: cjs/esm・named/default の判別（モジュール形式は getFunction では取れない・要 AST 追加）
    params: f.arg,             // 引数名のみ（型は含めない＝JS 静的解析の範囲）
    returnExprs: f.returnExprs ?? [],
    isAsync: f.start != null ? (asyncMap.get(f.start) ?? false) : false,
    accessPath: f.propertyPath,  // プロパティ公開（例 uuid.v4）。直接 export は undefined
    filePath: rel,
  } as ApiSymbol));
}

/** 指定ツリー（=1バージョン）の export API surface を構築 */
async function buildApiSurface(treeDir: string, version: string, tag: string): Promise<ApiSurface> {
  const symbols: ApiSymbol[] = [];
  for (const f of await listSourceFiles(treeDir)) {
    symbols.push(...await extractExports(f, treeDir));
  }
  return { version, tag, scope: 'export', symbols };
}

export default {
  listSourceFiles,
  extractExports,
  buildApiSurface,
};
