import fs from 'fs';
import path from 'path';
import getAllFiles from '../utils/getAllFiles';
import { getFunction } from '../astRelated/trace/getFunction';
import { getExportedNames } from '../astRelated/trace/getExportedNames';
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

/**
 * 1 ファイルの公開 export を ApiSymbol[] へ
 *   (1) getFunction: 関数/アロー/クラスの export（引数・返り式などの署名メタ付き）
 *   (2) getExportedNames: 関数でない export 名（変数・値・object メンバ）を kind='value' で補完
 *   同名は関数側を優先し，非関数名は名前の有無だけを表す最小シンボル
 */
async function extractExports(filePath: string, treeDir: string): Promise<ApiSymbol[]> {
  const rel = path.relative(treeDir, filePath);
  const funcs = await getFunction(filePath, 0); // mode 0 = export 関数のみ + async/optionKeys/exportStyle/kind
  const symbols: ApiSymbol[] = funcs.map(f => ({
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

  // 非関数 export 名を補完（getFunction が拾わなかった名前のみ value として追加）
  const known = new Set(symbols.map(s => s.name));
  for (const e of await getExportedNames(filePath)) {
    if (known.has(e.name)) continue;
    known.add(e.name);
    symbols.push({
      name: e.name,
      kind: 'value',
      exportStyle: e.exportStyle,
      params: [],
      returnExprs: [],
      isAsync: false,
      optionKeys: [],
      filePath: rel,
    } as ApiSymbol);
  }
  return symbols;
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
