import '../utils/loadEnv';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { CLONE_BASE, RUN_OUTPUT_BASE, toCsvCell, toDirName } from '../utils/evalShared';
import { deriveSubpath } from '../libDiff/diffSurface';
import { createAstFromFile } from '../astRelated/base/createAstFromFile';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

// surface から取れた公開 API の一覧を作り、.d.ts（名前と型）・DIAGNOSE（付録の related_apis・オブジェクト関係グラフ）と突き合わせる
//   入力: <実行>/intermediate_data/api_surface/<lib>/<更新後>/{pre,post}.json（2026-11-16 より前の実行は <実行>/work/surface/）・ライブラリのクローン（.d.ts を `git show <tag>:<file>` で読む）
//         prestudy/diagnose/diagnose/supplementary/detected_breaking_changes.csv・--diagnose-graphs <dir>/<lib>@<version>.json（任意）
//   出力: <実行>/public_api_inventory/（--out で変えられる）{key_results.json, detail_api_list.csv, detail_dts_check.csv, detail_diagnose_check.csv}
//   API の表記は DIAGNOSE と同じ: 入口ファイルの default → <lib> / 入口の名前 → <lib>.name / 他のファイル → <lib/sub>・<lib/sub>.name

const DIAGNOSE_CSV = '../../prestudy/diagnose/diagnose/supplementary/detected_breaking_changes.csv';

export interface PublicApi {
  library: string;
  version: string;
  api: string;           // DIAGNOSE 表記
  symbol: string;        // surface の記号名
  kind: string;          // function / class / value
  params: string[];
  isAsync: boolean;
  exportStyle: string;
  filePath: string;
  fromEntry: boolean;    // 入口ファイル（require('lib') で読まれるファイル）の記号か
  resolvedFrom?: string; // 再公開をたどった定義元
}

/** クライアントがその記号に触れる名前（accessPath のプロパティ名。無ければ記号の名前） */
const publicNameOf = (s: ApiSymbol): string =>
  (s.name !== 'default' && s.accessPath ? s.accessPath.split('.').slice(1).join('.') : s.name);

/** 1 バージョンの surface から公開 API の一覧を作る（同じ表記の API は関数・クラスを値より優先して1件） */
export function listPublicApis(library: string, surface: ApiSurface): PublicApi[] {
  const byApi = new Map<string, PublicApi>();
  for (const s of surface.symbols) {
    const fromEntry = surface.entryFile !== undefined && s.filePath === surface.entryFile;
    const base = fromEntry ? `<${library}>` : `<${library}/${deriveSubpath(s.filePath)}>`;
    const api = s.name === 'default' ? base : `${base}.${publicNameOf(s)}`;
    const row: PublicApi = {
      library, version: surface.version, api, symbol: s.name, kind: s.kind, params: s.params ?? [],
      isAsync: s.isAsync ?? false, exportStyle: s.exportStyle, filePath: s.filePath, fromEntry,
      ...(s.resolvedFrom ? { resolvedFrom: s.resolvedFrom } : {}),
    };
    const prev = byApi.get(api);
    if (!prev || (prev.kind === 'value' && row.kind !== 'value')) byApi.set(api, row);
  }
  return [...byApi.values()];
}

// ---------------------------------------------------------------
// .d.ts の宣言（名前・種類・引数の個数・Promise を返すか）

export interface DtsDeclaration {
  name: string;                         // export 名（default はモジュール本体）
  kind: 'function' | 'class' | 'value';
  arities: { min: number; max: number }[]; // 呼び出しシグネチャごとの引数の個数（max は rest なら Infinity）。関数でなければ空
  returnsPromise: boolean;              // どれかのシグネチャの戻り値が Promise / PromiseLike
}

const arityOf = (params: any[]): { min: number; max: number } => {
  const ps = params.filter(p => !(p.type === 'Identifier' && p.name === 'this'));
  let min = 0;
  let max = 0;
  for (const p of ps) {
    if (p.type === 'RestElement') return { min, max: Infinity };
    max++;
    if (!(p.optional || p.type === 'AssignmentPattern')) min = max;
  }
  return { min, max };
};

const returnsPromiseType = (ann: any): boolean => {
  const t = ann?.typeAnnotation ?? ann;
  return t?.type === 'TSTypeReference' && t.typeName?.type === 'Identifier' && ['Promise', 'PromiseLike'].includes(t.typeName.name);
};

interface Local { kind: DtsDeclaration['kind']; arities: DtsDeclaration['arities']; returnsPromise: boolean; members: Map<string, Local> }
const emptyLocal = (kind: DtsDeclaration['kind']): Local => ({ kind, arities: [], returnsPromise: false, members: new Map() });

// 型注釈から呼び出しシグネチャとメンバを読む（関数型・型リテラル・同じファイルの interface）
function localFromType(ann: any, interfaces: Map<string, any[]>): Local {
  const t = ann?.typeAnnotation ?? ann;
  if (!t) return emptyLocal('value');
  if (t.type === 'TSFunctionType') {
    return { kind: 'function', arities: [arityOf(t.parameters ?? t.params ?? [])], returnsPromise: returnsPromiseType(t.typeAnnotation ?? t.returnType), members: new Map() };
  }
  if (t.type === 'TSConstructorType') return { ...emptyLocal('class'), arities: [arityOf(t.parameters ?? t.params ?? [])] };
  const members = t.type === 'TSTypeLiteral' ? (t.members ?? [])
    : t.type === 'TSTypeReference' && t.typeName?.type === 'Identifier' ? (interfaces.get(t.typeName.name) ?? [])
      : t.type === 'TSIntersectionType' ? (t.types ?? []).flatMap((x: any) => (x.type === 'TSTypeLiteral' ? x.members ?? [] : x.type === 'TSTypeReference' && x.typeName?.type === 'Identifier' ? interfaces.get(x.typeName.name) ?? [] : []))
        : [];
  const local = emptyLocal('value');
  for (const m of members) {
    if (m.type === 'TSCallSignatureDeclaration') {
      local.kind = 'function';
      local.arities.push(arityOf(m.parameters ?? m.params ?? []));
      if (returnsPromiseType(m.typeAnnotation ?? m.returnType)) local.returnsPromise = true;
    } else if (m.type === 'TSConstructSignatureDeclaration' && local.kind === 'value') {
      local.kind = 'class';
    } else if ((m.type === 'TSMethodSignature' || m.type === 'TSPropertySignature') && m.key?.type === 'Identifier') {
      const sub = m.type === 'TSMethodSignature'
        ? { kind: 'function' as const, arities: [arityOf(m.parameters ?? m.params ?? [])], returnsPromise: returnsPromiseType(m.typeAnnotation ?? m.returnType), members: new Map() }
        : localFromType(m.typeAnnotation, interfaces);
      const prev = local.members.get(m.key.name);
      if (prev && prev.kind === 'function' && sub.kind === 'function') { prev.arities.push(...sub.arities); prev.returnsPromise ||= sub.returnsPromise; } else local.members.set(m.key.name, sub);
    }
  }
  return local;
}

/** .d.ts の本体（declare module 'lib' { … } の中身も含む）から値の宣言をローカル名で集める */
function collectLocals(body: any[]): Map<string, Local> {
  const interfaces = new Map<string, any[]>();
  for (const n of body) if (n.type === 'TSInterfaceDeclaration' && n.id?.name) interfaces.set(n.id.name, [...(interfaces.get(n.id.name) ?? []), ...(n.body?.body ?? [])]);
  const locals = new Map<string, Local>();
  const addFn = (name: string, fn: any) => {
    const l = locals.get(name) ?? emptyLocal('function');
    l.kind = l.kind === 'value' ? 'function' : l.kind;
    l.arities.push(arityOf(fn.params ?? []));
    if (returnsPromiseType(fn.returnType)) l.returnsPromise = true;
    locals.set(name, l);
  };
  const visit = (n: any) => {
    const d = n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration' ? n.declaration : n;
    if (!d) return;
    if ((d.type === 'TSDeclareFunction' || d.type === 'FunctionDeclaration') && d.id?.name) addFn(d.id.name, d);
    else if (d.type === 'ClassDeclaration' && d.id?.name) {
      const l = locals.get(d.id.name) ?? emptyLocal('class');
      l.kind = 'class';
      for (const m of d.body?.body ?? []) {
        if (m.type === 'ClassMethod' && m.kind === 'constructor') l.arities.push(arityOf(m.params ?? []));
        if (m.static && m.key?.type === 'Identifier') l.members.set(m.key.name, m.type === 'TSDeclareMethod' || m.type === 'ClassMethod'
          ? { kind: 'function', arities: [arityOf(m.params ?? [])], returnsPromise: returnsPromiseType(m.returnType), members: new Map() }
          : emptyLocal('value'));
      }
      locals.set(d.id.name, l);
    } else if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations ?? []) if (v.id?.name) locals.set(v.id.name, localFromType(v.id.typeAnnotation, interfaces));
    } else if (d.type === 'TSModuleDeclaration' && d.id?.type === 'Identifier' && d.body?.type === 'TSModuleBlock') {
      const l = locals.get(d.id.name) ?? emptyLocal('value');
      for (const [k, v] of collectLocals(d.body.body ?? [])) l.members.set(k, v);
      locals.set(d.id.name, l);
    }
  };
  for (const n of body) visit(n);
  return locals;
}

/** .d.ts の値 export を宣言として読む（型だけの export は除く。export = X は X を default、X のメンバを名前つき export とする） */
export function readDtsDeclarations(dtsFile: string, content: string): Map<string, DtsDeclaration> {
  const out = new Map<string, DtsDeclaration>();
  const ast = createAstFromFile(dtsFile.endsWith('.ts') ? dtsFile : `${dtsFile}.d.ts`, content);
  if (!ast) return out;
  const program = ast.program.body as any[];
  const body = [...program, ...program
    .filter(n => n.type === 'TSModuleDeclaration' && n.id?.type === 'StringLiteral' && n.body?.type === 'TSModuleBlock')
    .flatMap(n => n.body.body ?? [])];
  const locals = collectLocals(body);
  const put = (name: string, l: Local | undefined) => {
    if (!l || out.has(name)) return;
    out.set(name, { name, kind: l.kind, arities: l.arities, returnsPromise: l.returnsPromise });
  };
  for (const n of body) {
    if (n.type === 'ExportNamedDeclaration' && n.exportKind !== 'type') {
      const d = n.declaration;
      if (d && d.id?.name) put(d.id.name, locals.get(d.id.name));
      if (d?.type === 'VariableDeclaration') for (const v of d.declarations ?? []) if (v.id?.name) put(v.id.name, locals.get(v.id.name));
      for (const sp of n.specifiers ?? []) {
        if (sp.exportKind === 'type') continue;
        const exported = sp.exported?.name ?? sp.exported?.value;
        const local = sp.local?.name ?? exported;
        if (exported) put(exported, locals.get(local) ?? emptyLocal('value'));
      }
    } else if (n.type === 'ExportDefaultDeclaration') {
      const d = n.declaration;
      put('default', d?.type === 'Identifier' ? locals.get(d.name) : d?.id?.name ? locals.get(d.id.name)
        : d?.type === 'TSDeclareFunction' || d?.type === 'FunctionDeclaration' ? { ...emptyLocal('function'), arities: [arityOf(d.params ?? [])], returnsPromise: returnsPromiseType(d.returnType) }
          : emptyLocal(d?.type === 'ClassDeclaration' ? 'class' : 'value'));
    } else if (n.type === 'TSExportAssignment' && n.expression?.type === 'Identifier') {
      const l = locals.get(n.expression.name);
      if (!l) continue;
      put('default', l);
      for (const [k, v] of l.members) put(k, v);
    }
  }
  return out;
}

export interface DtsCheck {
  library: string;
  version: string;
  api: string;
  inDts: boolean;
  inSurface: boolean;
  dtsKind?: string;
  surfaceKind?: string;
  dtsArity?: string;      // 例 "1-3" / "2" / "0-*"（シグネチャが複数なら | で区切る）
  surfaceParams?: string;
  kindResult?: 'same' | 'different' | 'value-in-surface';
  arityResult?: 'same' | 'surface-more' | 'surface-fewer' | 'not-compared';
  asyncResult?: 'same' | 'promise-in-dts-only' | 'async-in-surface-only';
}

const fmtArity = (a: { min: number; max: number }) => (a.max === Infinity ? `${a.min}-*` : a.min === a.max ? `${a.max}` : `${a.min}-${a.max}`);

/**
 * 入口ファイルの公開 API と .d.ts の宣言を名前・種類・引数の個数・Promise で比べる
 *   引数: surface の個数がどれかのシグネチャの min〜max に入れば same。surface が rest（...x）を持てば same
 *   種類: surface が value（署名が分からない）なら value-in-surface
 */
export function checkAgainstDts(library: string, version: string, apis: PublicApi[], decls: Map<string, DtsDeclaration>): DtsCheck[] {
  const entry = new Map(apis.filter(a => a.fromEntry).map(a => [a.symbol === 'default' ? 'default' : a.api.slice(`<${library}>.`.length), a]));
  const rows: DtsCheck[] = [];
  for (const [name, d] of decls) {
    const api = name === 'default' ? `<${library}>` : `<${library}>.${name}`;
    const s = entry.get(name);
    const row: DtsCheck = { library, version, api, inDts: true, inSurface: !!s, dtsKind: d.kind, dtsArity: d.arities.map(fmtArity).join('|') };
    if (s) {
      row.surfaceKind = s.kind;
      row.surfaceParams = s.params.join(', ');
      row.kindResult = s.kind === 'value' ? 'value-in-surface' : s.kind === d.kind ? 'same' : 'different';
      if (s.kind === 'value' || d.arities.length === 0) row.arityResult = 'not-compared';
      else {
        const n = s.params.length;
        const rest = s.params.some(p => p.startsWith('...'));
        row.arityResult = rest || d.arities.some(a => a.min <= n && n <= a.max) ? 'same'
          : d.arities.every(a => n > a.max) ? 'surface-more' : 'surface-fewer';
      }
      row.asyncResult = d.returnsPromise === s.isAsync ? 'same' : d.returnsPromise ? 'promise-in-dts-only' : 'async-in-surface-only';
    }
    rows.push(row);
  }
  for (const [name, s] of entry) {
    if (decls.has(name)) continue;
    rows.push({ library, version, api: s.api, inDts: false, inSurface: true, surfaceKind: s.kind, surfaceParams: s.params.join(', ') });
  }
  return rows;
}

// ---------------------------------------------------------------
// DIAGNOSE との突き合わせ

/** related_apis の表記（<lib>.{a,b}().c など）から1段目の API 名を取り出す（<lib>.a・<lib>.b） */
export function firstLevelApis(relatedApis: string): string[] {
  const out = new Set<string>();
  for (const m of relatedApis.matchAll(/<([^>]+)>(?:\.(\{[^}]*\}|[\w$]+))?/g)) {
    const mod = `<${m[1]}>`;
    if (!m[2]) { out.add(mod); continue; }
    const names = m[2].startsWith('{') ? m[2].slice(1, -1).split(',').map(x => x.trim()).filter(Boolean) : [m[2]];
    for (const n of names) out.add(`${mod}.${n}`);
  }
  return [...out];
}

/** DIAGNOSE のオブジェクト関係グラフ（schema.json の形）から、開始ノードの ownProp を depth 段までたどった API 名 */
export function apisFromDiagnoseGraph(library: string, graph: { nodes: any[] }, depth = 1): string[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const start = graph.nodes.find(n => n.type === 'start');
  if (!start) return [];
  const out = new Set<string>([`<${library}>`]);
  const walk = (node: any, prefix: string, d: number) => {
    if (d === 0 || !node) return;
    for (const e of node.edges ?? []) {
      if (e.type !== 'ownProp' || typeof e.name !== 'string') continue;
      const api = `${prefix}.${e.name}`;
      out.add(api);
      walk(byId.get(e.target?.nodeId), api, d - 1);
    }
  };
  walk(start, `<${library}>`, depth);
  return [...out];
}

// ---------------------------------------------------------------
// 実行

interface SurfaceFile { npm_pkg: string; surface: ApiSurface }

/** 実行の surface のフォルダ（新しい構成 → 2026-11-16 より前の構成の順に探す） */
function surfaceDirOf(runDir: string): string {
  const dirs = [path.join(runDir, 'intermediate_data/api_surface'), path.join(runDir, 'work/surface')];
  return dirs.find(d => fs.existsSync(d)) ?? dirs[0];
}

/** 実行の surface から lib@version ごとの surface を1つずつ読む */
function readSurfaces(runDir: string): { surfaces: Map<string, { library: string; surface: ApiSurface }>; preOf: Map<string, string> } {
  const dir = surfaceDirOf(runDir);
  const out = new Map<string, { library: string; surface: ApiSurface }>();
  const preOf = new Map<string, string>(); // lib@更新後 → 更新前
  for (const lib of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    for (const ver of fs.readdirSync(path.join(dir, lib))) {
      for (const side of ['pre.json', 'post.json']) {
        const f = path.join(dir, lib, ver, side);
        if (!fs.existsSync(f)) continue;
        const j = JSON.parse(fs.readFileSync(f, 'utf-8')) as SurfaceFile & { prevVersion: string; updatedVersion: string };
        preOf.set(`${j.npm_pkg}@${j.updatedVersion}`, j.prevVersion);
        const key = `${j.npm_pkg}@${j.surface.version}`;
        if (!out.has(key)) out.set(key, { library: j.npm_pkg, surface: j.surface });
      }
    }
  }
  return { surfaces: out, preOf };
}

/** ライブラリのクローンから tag 時点の .d.ts を読む（読めなければ undefined） */
function readDtsAtTag(library: string, tag: string, dtsFile: string): string | undefined {
  try {
    return execFileSync('git', ['-C', path.resolve(process.cwd(), CLONE_BASE, toDirName(library)), 'show', `${tag}:${dtsFile}`],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  } catch {
    return undefined;
  }
}

const writeCsv = (file: string, rows: Record<string, unknown>[], cols: string[]) =>
  fs.writeFileSync(file, [cols.join(','), ...rows.map(r => cols.map(c => toCsvCell(r[c])).join(','))].join('\n') + '\n');

const rate = (n: number, d: number) => (d === 0 ? null : +(n / d).toFixed(3));

export function runPublicApiInventory(runDir: string, diagnoseGraphDir?: string, outDirArg?: string): void {
  const { surfaces, preOf } = readSurfaces(runDir);
  if (surfaces.size === 0) {
    console.error(`[publicApiInventory] ${surfaceDirOf(runDir)} に surface が無い（先に make run / make detect）`);
    process.exit(1);
  }
  const outDir = outDirArg ?? path.join(runDir, 'public_api_inventory');
  fs.mkdirSync(outDir, { recursive: true });

  const apiRows: PublicApi[] = [];
  const dtsRows: DtsCheck[] = [];
  const versionsByLib = new Map<string, Map<string, PublicApi[]>>();
  let withDts = 0;
  let dtsRead = 0;
  for (const { library, surface } of surfaces.values()) {
    const apis = listPublicApis(library, surface);
    apiRows.push(...apis);
    if (!versionsByLib.has(library)) versionsByLib.set(library, new Map());
    versionsByLib.get(library)!.set(surface.version, apis);
    const dtsFile = surface.dtsValidation?.hasDts ? surface.dtsValidation.dtsFile : undefined;
    if (!dtsFile) continue;
    withDts++;
    const content = readDtsAtTag(library, surface.tag, dtsFile);
    if (content === undefined) continue;
    dtsRead++;
    dtsRows.push(...checkAgainstDts(library, surface.version, apis, readDtsDeclarations(dtsFile, content)));
  }

  // DIAGNOSE: 付録の related_apis（壊れた API）が、更新前のバージョンの一覧にあるか
  const diagnoseRows: Record<string, unknown>[] = [];
  const csvPath = path.resolve(process.cwd(), DIAGNOSE_CSV);
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'latin1').split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) ?? [];
      const [library, , , update, , related] = cells;
      const versions = versionsByLib.get(library);
      if (!versions || !related) continue;
      // 更新後が update のバージョンペアの更新前（そのペアが無ければ一覧にある全バージョン）
      const pre = preOf.get(`${library}@${update}`);
      const pool = new Set((pre ? versions.get(pre) ?? [] : [...versions.values()].flat()).map(a => a.api));
      for (const api of firstLevelApis(related)) diagnoseRows.push({ source: 'supplementary', library, version: pre ?? '*', update, api, inSurface: pool.has(api) });
    }
  }
  // DIAGNOSE のグラフ（<dir>/<lib>@<version>.json）があれば、その API がこちらの一覧にあるか・こちらにしか無い API
  if (diagnoseGraphDir && fs.existsSync(diagnoseGraphDir)) {
    for (const f of fs.readdirSync(diagnoseGraphDir).filter(x => x.endsWith('.json'))) {
      const at = f.lastIndexOf('@');
      if (at <= 0) continue;
      const library = f.slice(0, at);
      const version = f.slice(at + 1, -'.json'.length);
      const ours = new Set((versionsByLib.get(library)?.get(version) ?? []).filter(a => a.fromEntry).map(a => a.api));
      const theirs = new Set(apisFromDiagnoseGraph(library, JSON.parse(fs.readFileSync(path.join(diagnoseGraphDir, f), 'utf-8'))));
      for (const api of theirs) diagnoseRows.push({ source: 'graph', library, version, api, inSurface: ours.has(api), inDiagnose: true });
      for (const api of ours) if (!theirs.has(api)) diagnoseRows.push({ source: 'graph', library, version, api, inSurface: true, inDiagnose: false });
    }
  }

  writeCsv(path.join(outDir, 'detail_api_list.csv'), apiRows.map(a => ({ ...a, params: a.params.join(', ') })),
    ['library', 'version', 'api', 'symbol', 'kind', 'params', 'isAsync', 'exportStyle', 'filePath', 'fromEntry', 'resolvedFrom']);
  writeCsv(path.join(outDir, 'detail_dts_check.csv'), dtsRows as unknown as Record<string, unknown>[],
    ['library', 'version', 'api', 'inDts', 'inSurface', 'dtsKind', 'surfaceKind', 'dtsArity', 'surfaceParams', 'kindResult', 'arityResult', 'asyncResult']);
  writeCsv(path.join(outDir, 'detail_diagnose_check.csv'), diagnoseRows, ['source', 'library', 'version', 'update', 'api', 'inSurface', 'inDiagnose']);

  const declared = dtsRows.filter(r => r.inDts);
  const matched = declared.filter(r => r.inSurface);
  const count = (key: keyof DtsCheck, v: string) => matched.filter(r => r[key] === v).length;
  const entryApis = apiRows.filter(a => a.fromEntry);
  const summary = {
    runDir,
    versions: surfaces.size,
    libraries: versionsByLib.size,
    apis: { all: apiRows.length, entry: entryApis.length, entryFunctions: entryApis.filter(a => a.kind !== 'value').length,
      entryValues: entryApis.filter(a => a.kind === 'value').length, entryResolvedReexports: entryApis.filter(a => a.resolvedFrom).length },
    versionsWithoutEntryFile: [...surfaces.values()].filter(s => !s.surface.entryFile).length,
    dts: {
      versionsWithDts: withDts, shareOfVersions: rate(withDts, surfaces.size), versionsRead: dtsRead,
      declaredValueExports: declared.length, foundInSurface: matched.length, nameCoverage: rate(matched.length, declared.length),
      surfaceOnly: dtsRows.filter(r => !r.inDts).length,
      kind: { same: count('kindResult', 'same'), different: count('kindResult', 'different'), valueInSurface: count('kindResult', 'value-in-surface') },
      arity: { same: count('arityResult', 'same'), surfaceMore: count('arityResult', 'surface-more'), surfaceFewer: count('arityResult', 'surface-fewer'), notCompared: count('arityResult', 'not-compared') },
      async: { same: count('asyncResult', 'same'), promiseInDtsOnly: count('asyncResult', 'promise-in-dts-only'), asyncInSurfaceOnly: count('asyncResult', 'async-in-surface-only') },
    },
    diagnose: {
      supplementary: { apis: diagnoseRows.filter(r => r.source === 'supplementary').length, inSurface: diagnoseRows.filter(r => r.source === 'supplementary' && r.inSurface).length },
      graph: diagnoseGraphDir ? {
        diagnoseApis: diagnoseRows.filter(r => r.source === 'graph' && r.inDiagnose).length,
        alsoInSurface: diagnoseRows.filter(r => r.source === 'graph' && r.inDiagnose && r.inSurface).length,
        surfaceOnly: diagnoseRows.filter(r => r.source === 'graph' && !r.inDiagnose).length,
      } : null,
    },
  };
  fs.writeFileSync(path.join(outDir, 'key_results.json'), JSON.stringify(summary, null, 2));
  console.log(`[publicApiInventory] ${outDir}`);
  console.log(JSON.stringify(summary, null, 2));
}

// 例: npx tsx evaluation/publicApiInventory.ts --run ../../outputs/history/BC-LC/<日時>_<モード> [--diagnose-graphs <dir>] [--out <dir>]
if (process.argv[1] && /publicApiInventory\.(ts|js)$/.test(process.argv[1])) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const out = arg('--out');
  runPublicApiInventory(path.resolve(process.cwd(), arg('--run') ?? RUN_OUTPUT_BASE), arg('--diagnose-graphs'), out ? path.resolve(process.cwd(), out) : undefined);
}
