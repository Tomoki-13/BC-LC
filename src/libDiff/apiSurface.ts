import fs from 'fs';
import path from 'path';
import getAllFiles from '../utils/getAllFiles';
import { getFunction } from '../astRelated/trace/getFunction';
import { getExportsAndImports } from '../astRelated/trace/getExportedNames';
import type { ApiSymbol, ApiSurface, ExportStyle, PackageExports, SymbolKind } from '../types/LibDiff';
import { validateAgainstDts } from './dtsValidation';
import { findPublishedMissing, findUnpublishedFiles } from './publishedFiles';

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

/** package.json の type を読む．入力: repo/版ツリー / 出力: 'module'（ESM）/ 'commonjs'（無指定含む既定） */
function readModuleType(treeDir: string): 'module' | 'commonjs' {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf-8'));
    return pkg?.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'commonjs';
  }
}

/** exports の値（条件オブジェクト・配列・文字列）が require で読めるか。条件が import/browser だけなら false */
function allowsRequire(value: unknown): boolean {
  if (typeof value === 'string') return !value.endsWith('.mjs');
  if (Array.isArray(value)) return value.some(allowsRequire);
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return ['require', 'node', 'default'].some(k => k in v && allowsRequire(v[k]));
  }
  return false;
}

/**
 * package.json exports を読む．入力: 版ツリー / 出力: 公開サブパスと本体の require 可否（exports が無ければ undefined）
 *   exports はキーが '.' で始まればサブパスの対応表、そうでなければ本体 '.' だけの指定（文字列・条件オブジェクト・配列）
 */
function readPackageExports(treeDir: string): PackageExports | undefined {
  try {
    const exp = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf-8'))?.exports;
    if (exp === undefined || exp === null) return undefined;
    const isSubpathMap = typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some(k => k.startsWith('.'));
    if (!isSubpathMap) return { subpaths: ['.'], rootRequire: allowsRequire(exp) };
    return { subpaths: Object.keys(exp), rootRequire: '.' in exp ? allowsRequire(exp['.']) : false };
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
async function extractExports(filePath: string, treeDir: string): Promise<{ symbols: ApiSymbol[]; imports: Record<string, string> }> {
  const rel = path.relative(treeDir, filePath);
  const funcs = await getFunction(filePath, 0); // mode 0 = export 関数のみ + async/optionKeys/exportStyle/kind
  const toSymbol = (f: typeof funcs[number]): ApiSymbol => ({
    name: f.name,
    kind: (f.kind ?? 'function') as SymbolKind,
    exportStyle: (f.exportStyle ?? 'unknown') as ExportStyle,
    params: f.arg,             // 引数名のみ（型は含めない＝JS 静的解析の範囲）
    returnExprs: f.returnExprs ?? [],
    isAsync: f.isAsync ?? false,
    accessPath: f.propertyPath,  // プロパティ公開（例 uuid.v4）。直接 export は undefined
    optionKeys: f.optionKeys ?? [],
    filePath: rel,
  } as ApiSymbol);

  // default で公開される関数・クラスは、クライアントからは名前が見えないので 'default' の記号にする（元の名前は localName）
  //   同じファイルに複数あるとき（分岐ごとの module.exports = …）は後ろのもの（start が最大）を default にする
  //   名前でも公開されている（module.exports = v4; module.exports.v4 = v4）ときは、名前の記号を残して default を別に足す
  const defaultFn = funcs
    .filter(f => f.defaultExportStyle !== undefined)
    .reduce<typeof funcs[number] | undefined>((last, f) => (!last || (f.start ?? 0) >= (last.start ?? 0) ? f : last), undefined);
  const alsoNamed = defaultFn !== undefined && defaultFn.exportStyle !== defaultFn.defaultExportStyle;
  const symbols: ApiSymbol[] = funcs.map(f => (f === defaultFn && !alsoNamed
    ? { ...toSymbol(f), name: 'default', localName: f.name !== 'default' ? f.name : undefined }
    : toSymbol(f)));
  if (defaultFn && alsoNamed) {
    symbols.push({
      ...toSymbol(defaultFn), name: 'default', localName: defaultFn.name, accessPath: undefined,
      exportStyle: defaultFn.defaultExportStyle as ExportStyle,
    });
  }

  // 非関数 export 名を補完（getFunction が拾わなかった名前のみ value として追加）
  const known = new Set(symbols.map(s => s.name));
  const { names, imports } = await getExportsAndImports(filePath);
  for (const e of names) {
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
      ...(e.from ? { reexport: e.from } : {}),
    } as ApiSymbol);
  }
  return { symbols, imports };
}

const RESOLVE_EXT = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '/index.js', '/index.ts'];

/** 相対指定子を、そのまま → 拡張子補完 → /index の順に surface のファイルへ解決する。無ければ undefined */
function resolveRelativeFile(fromFile: string, spec: string, files: Set<string>): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)).replace(/\/$/, '');
  return RESOLVE_EXT.map(e => base + e).find(c => files.has(c));
}

/**
 * 相対パスの読み込みをそのまま公開している値に、読み込み先の関数・クラスの署名を写す
 *   例: uuid 3.4.0 index.js の uuid.v1 = require('./v1') → v1.js の default 関数 v1(options, buf, offset)
 *       lie 2.9.1 lib/index.js の module.exports = require('./promise') → lib/promise.js の default 関数 Promise(resolver)
 *   読み込み先も値の再公開なら 5 段までたどる。名前・公開形・ファイルは公開した側のまま
 */
function resolveReexports(symbols: ApiSymbol[]): void {
  const files = new Set(symbols.map(s => s.filePath));
  const byFile = new Map<string, ApiSymbol[]>();
  for (const s of symbols) {
    const arr = byFile.get(s.filePath);
    if (arr) arr.push(s); else byFile.set(s.filePath, [s]);
  }
  const definitionOf = (sym: ApiSymbol, depth: number): ApiSymbol | undefined => {
    if (!sym.reexport || depth > 5) return undefined;
    const target = resolveRelativeFile(sym.filePath, sym.reexport.spec, files);
    if (!target) return undefined;
    const found = byFile.get(target)?.find(s => s.name === sym.reexport!.imported);
    if (!found) return undefined;
    return found.kind === 'value' ? definitionOf(found, depth + 1) : found;
  };
  for (const s of symbols) {
    if (s.kind !== 'value' || !s.reexport) continue;
    const def = definitionOf(s, 0);
    if (!def) continue;
    Object.assign(s, {
      kind: def.kind, params: def.params, returnExprs: def.returnExprs, isAsync: def.isAsync, optionKeys: def.optionKeys,
      resolvedFrom: `${def.filePath}#${def.name}`,
    });
  }
}

const BUILD_DIR = /^(\.\/)?(dist|build|out|es|esm|cjs|umd)\//;

/**
 * require('lib') で読まれる入口ファイルを surface のファイルから決める
 *   package.json の main / module を解決する。ビルド成果物（dist/ 等・surface の対象外）なら、先頭のビルドのディレクトリを
 *   src/・lib/・source/・ルートに置き換えたファイル（例 dist/promisify.js → lib/promisify.js）、慣例の置き場（index / src/index / lib/index / <name>）を順に探す
 */
export function resolveEntryFile(pkg: any, files: Set<string>): string | undefined {
  const specs: string[] = [];
  let name: string | undefined;
  for (const f of [pkg?.main, pkg?.module, pkg?.['jsnext:main']]) {
    if (typeof f !== 'string' || f.length === 0) continue;
    specs.push(f);
    if (BUILD_DIR.test(f)) for (const dir of ['src/', 'lib/', 'source/', '']) specs.push(f.replace(BUILD_DIR, dir));
  }
  if (typeof pkg?.name === 'string') name = pkg.name.replace(/^@[^/]+\//, '');
  specs.push('index', 'src/index', 'lib/index');
  if (name) specs.push(name, `src/${name}`, `lib/${name}`);
  for (const spec of specs) {
    const found = resolveRelativeFile('package.json', `./${spec.replace(/^\.\//, '')}`, files);
    if (found) return found;
  }
  return undefined;
}

function findEntryFile(treeDir: string, files: Set<string>): string | undefined {
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf-8'));
  } catch { /* package.json が読めなければ慣例の置き場だけで探す */ }
  return resolveEntryFile(pkg, files);
}

/** 指定ツリー（=1バージョン）の export API surface を構築 */
async function buildApiSurface(treeDir: string, version: string, tag: string): Promise<ApiSurface> {
  const symbols: ApiSymbol[] = [];
  const importsByFile: Record<string, Record<string, string>> = {};
  const sourceFiles = await listSourceFiles(treeDir);
  for (const f of sourceFiles) {
    const r = await extractExports(f, treeDir);
    symbols.push(...r.symbols);
    if (r.symbols.length > 0 && Object.keys(r.imports).length > 0) importsByFile[path.relative(treeDir, f)] = r.imports;
  }
  resolveReexports(symbols);
  const relSources = sourceFiles.map(f => path.relative(treeDir, f));
  const entryFile = findEntryFile(treeDir, new Set(relSources));
  return {
    version, tag, scope: 'export', symbols,
    engines: readEngines(treeDir), moduleType: readModuleType(treeDir),
    dtsValidation: validateAgainstDts(treeDir, symbols),
    publishedMissing: findPublishedMissing(treeDir), packageExports: readPackageExports(treeDir),
    entryFile,
    unpublishedFiles: findUnpublishedFiles(treeDir, [...new Set(symbols.map(s => s.filePath))], entryFile),
    importsByFile,
  };
}

export default {
  buildApiSurface,
};
