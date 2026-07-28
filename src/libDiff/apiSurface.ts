import fs from 'fs';
import path from 'path';
import getAllFiles from '../utils/getAllFiles';
import { getFunction } from '../astRelated/trace/getFunction';
import type { ApiSymbol, ApiSurface, ExportStyle, SymbolKind } from '../types/LibDiff';

const SOURCE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

/** package.json の engines(node/npm) を読む．入力: repo/版ツリー / 出力: {node?,npm?}（無ければ undefined） */
function readEngines(treeDir: string): { node?: string; npm?: string } | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf-8'));
    const engines = pkg?.engines;
    if (!engines || typeof engines !== 'object') return undefined;
    const result: { node?: string; npm?: string } = {};
    if (typeof engines.node === 'string') result.node = engines.node;
    if (typeof engines.npm === 'string') result.npm = engines.npm;
    return result.node || result.npm ? result : undefined;
  } catch {
    return undefined;
  }
}

/** ツリー配下の解析対象ソースを列挙（除外方針は getAllFiles に準拠） */
async function listSourceFiles(treeDir: string): Promise<string[]> {
  const files = await getAllFiles(treeDir);
  return files.filter(f => SOURCE_EXT.includes(path.extname(f)));
}

/** 1 ファイルの export 関数を ApiSymbol[] へ（getFunction mode 0 が surface メタも返す） */
async function extractExports(filePath: string, treeDir: string): Promise<ApiSymbol[]> {
  const funcs = await getFunction(filePath, 0); // mode 0 = export 関数のみ + async/optionKeys/exportStyle/kind
  const rel = path.relative(treeDir, filePath);
  return funcs.map(f => ({
    name: f.name,
    kind: (f.kind ?? 'function') as SymbolKind,
    exportStyle: (f.exportStyle ?? 'unknown') as ExportStyle,
    params: f.arg,             // 引数名のみ（型は含めない＝JS 静的解析の範囲）
    returnExprs: f.returnExprs ?? [],
    isAsync: f.isAsync ?? false,
    accessPath: f.propertyPath,  // プロパティ公開（例 uuid.v4）。直接 export は undefined
    optionKeys: f.optionKeys ?? [],
    filePath: rel,
  } as ApiSymbol));
}

/** 指定ツリー（=1バージョン）の export API surface を構築 */
async function buildApiSurface(treeDir: string, version: string, tag: string): Promise<ApiSurface> {
  const symbols: ApiSymbol[] = [];
  for (const f of await listSourceFiles(treeDir)) {
    symbols.push(...await extractExports(f, treeDir));
  }
  return { version, tag, scope: 'export', symbols, engines: readEngines(treeDir) };
}

export default {
  buildApiSurface,
};
