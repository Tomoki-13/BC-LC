import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import OutputJson from '../utils/output_json';
import {
  PATTERNS_PATH, RECORDS_PATH, SURFACE_DIR, ANALYSIS_DIR, AUDIT_DIR, EXTRACTION_COVERAGE_DIR, CLONE_BASE,
  toCsvCell, toDirName, PatternRecord, DetectionRecord,
} from '../utils/evalShared';
import DiffSurface, { deriveSubpath } from '../libDiff/diffSurface';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

// 損失と判定した API（＝パターン化した API。損失候補1件ごとにパターンを作るため一致する）を版ペアごとに列挙する（DIAGNOSE 等の既存手法との突き合わせ用）。
//   入力: library-detect/records.json（損失候補）・patterns/patterns.json（生成パターン）・surface/（公開形）
//         audit/resolution_log.csv＋lib clone の package.json（main＝ライブラリ本体のファイル）・results/extraction-coverage/dts_coverage.json（任意）
//   出力: analysis/capturedSymbols/{loss_api_list.csv, by_lib.json, dts_gap.csv, summary.json}
//   API の表記は DIAGNOSE（supplementary/detected_breaking_changes.csv の related_apis）に合わせる:
//     本体の default export → <lib> / 本体の名前付き export・プロパティ → <lib>.name
//     本体以外のファイル（サブパス）→ <lib/sub> / <lib/sub>.name / package.json 由来のタグ → <lib>

// symbol を持たずモジュール全体に効くタグ（package.json 由来）
const PACKAGE_LEVEL_TAGS = new Set(['published-file-missing', 'node-npm-requirement-raised', 'module-format-changed']);
// symbol が公開サブパス（deriveSubpath 済み）そのものであるタグ
const SUBPATH_TAGS = new Set(['deep-import-broken', 'module-removed']);

interface ApiRow {
  library: string;
  prevVersion: string;
  updatedVersion: string;
  api: string;
  tag: string;
  confidence: string;
  lossByClientTest: boolean;
  failCount: number;
  succCount: number;
  sourceSymbols: Set<string>; // 元の symbol@filePath（同じ API に複数の定義がまとまることがある）
}

// records.json の1件（採点用の DetectionRecord に失敗・成功数を足した実際の形）
interface LossRecord extends DetectionRecord {
  failCount: number;
  succCount: number;
}

interface DtsRecord { libName: string; version: string; hasDts: boolean; coverage?: number; missing?: string[] }

const readJson = (p: string): any => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
};

/** audit/resolution_log.csv から lib|version → checkout した ref */
function loadRefs(): Map<string, string> {
  const refs = new Map<string, string>();
  const p = path.resolve(process.cwd(), AUDIT_DIR, 'resolution_log.csv');
  if (!fs.existsSync(p)) return refs;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n').slice(1)) {
    const [lib, version, , ref] = line.split(',');
    if (lib && version && ref) refs.set(`${lib}|${version}`, ref);
  }
  return refs;
}

/**
 * その版の本体ファイル（ライブラリを `require('lib')` したときに読まれるソース）を surface の filePath として返す
 *   package.json の main / module を Node の解決順（そのまま → 拡張子補完 → /index）で surface のファイルから探す。
 *   main がビルド成果物（dist/ 等・surface の対象外）を指すときは、慣例の置き場（index / src/index / lib/index / <lib>.js）を順に探す
 */
function entryFileOf(lib: string, version: string, refs: Map<string, string>, files: Set<string>): string {
  const specs: string[] = [];
  const ref = refs.get(`${lib}|${version}`);
  if (ref) {
    try {
      const pkg = JSON.parse(execSync(`git -C "${path.resolve(process.cwd(), CLONE_BASE, toDirName(lib))}" show "${ref}:package.json"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));
      for (const f of [pkg.main, pkg.module, pkg['jsnext:main']]) if (typeof f === 'string' && f.length > 0) specs.push(f);
    } catch { /* package.json が読めなければ慣例の置き場だけで探す */ }
  }
  specs.push('index', 'src/index', 'lib/index', lib, `src/${lib}`, `lib/${lib}`);
  for (const spec of specs) {
    const base = path.posix.normalize(spec.replace(/^\.\//, '')).replace(/\/$/, '').replace(/\.[cm]?[jt]s$/, '');
    for (const c of [`${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.ts`]) {
      if (files.has(c)) return c;
    }
  }
  return 'index.js';
}

/** 損失候補1件を DIAGNOSE 表記の API 名にする */
function apiNameOf(lib: string, tag: string, symbol: string, sym: ApiSymbol | undefined, entryFile: string): string {
  if (PACKAGE_LEVEL_TAGS.has(tag)) return `<${lib}>`;
  if (SUBPATH_TAGS.has(tag)) return `<${lib}/${symbol}>`;
  const filePath = sym?.filePath ?? entryFile;
  const base = filePath === entryFile ? `<${lib}>` : `<${lib}/${deriveSubpath(filePath)}>`;
  if (sym?.accessPath) return `${base}.${sym.accessPath.split('.').slice(1).join('.')}`;
  const isDefault = symbol === 'default' || sym?.exportStyle === 'cjs-module-default' || sym?.exportStyle === 'esm-default';
  return isDefault ? base : `${base}.${symbol}`;
}

export function runCapturedSymbols(): void {
  const recordsPath = path.resolve(process.cwd(), RECORDS_PATH);
  const patternsPath = path.resolve(process.cwd(), PATTERNS_PATH);
  if (!fs.existsSync(recordsPath) || !fs.existsSync(patternsPath)) {
    console.error(`[capturedSymbols] ${recordsPath} か ${patternsPath} が無い（先に make detect / make run）`);
    process.exit(1);
  }
  const records: LossRecord[] = JSON.parse(fs.readFileSync(recordsPath, 'utf-8'));
  const patternRecs: PatternRecord[] = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));
  const pairKey = (lib: string, prev: string, upd: string) => `${lib}|${prev}|${upd}`;
  // 損失なのにパターンが1本も作れなかった候補（generatePatterns の skipped）。設計上 0 のはずで、出たら変換器の不備
  const skippedCandidates = patternRecs.reduce((n, r) => n + (r.skippedTags?.length ?? 0), 0);
  const refs = loadRefs();

  const rows = new Map<string, ApiRow>(); // key = pair|api|tag
  for (const rec of records) {
    if (rec.candidates.length === 0) continue;
    const lib = rec.npm_pkg;
    const surfaceDir = path.resolve(process.cwd(), SURFACE_DIR, toDirName(lib), rec.updatedVersion.replace(/[^a-zA-Z0-9_.@-]/g, '_'));
    const preFile = readJson(path.join(surfaceDir, 'pre.json'));
    const postFile = readJson(path.join(surfaceDir, 'post.json'));
    const preSurface: ApiSurface | undefined = preFile?.prevVersion === rec.prevVersion ? preFile.surface : undefined;
    const postSurface: ApiSurface | undefined = postFile?.prevVersion === rec.prevVersion ? postFile.surface : undefined;
    const preSyms: ApiSymbol[] = preSurface?.symbols ?? [];
    const postSyms: ApiSymbol[] = postSurface?.symbols ?? [];
    // 2026-10-09 以前の records は候補に symbol/filePath を持たないので、判定に使った surface から同じ関数で候補を取り直す
    const candidates = rec.candidates.every(c => c.symbol !== undefined) || !preSurface || !postSurface
      ? rec.candidates
      : DiffSurface.diffSurface(preSurface, postSurface, lib);
    const entryFile = entryFileOf(lib, rec.prevVersion, refs, new Set(preSyms.map(s => s.filePath)));

    for (const c of candidates) {
      // 候補の symbol は pre（削除系）か post（署名変化系）の定義名。同じファイルの定義で公開形を引く
      const sym = preSyms.find(s => s.name === c.symbol && s.filePath === c.filePath)
        ?? postSyms.find(s => s.name === c.symbol && s.filePath === c.filePath);
      const api = apiNameOf(lib, c.tag, c.symbol ?? '', sym, entryFile);
      const key = `${pairKey(lib, rec.prevVersion, rec.updatedVersion)}|${api}|${c.tag}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          library: lib, prevVersion: rec.prevVersion, updatedVersion: rec.updatedVersion, api, tag: c.tag,
          confidence: c.confidence, lossByClientTest: rec.lossByClientTest,
          failCount: rec.failCount, succCount: rec.succCount, sourceSymbols: new Set(),
        };
        rows.set(key, row);
      }
      if (c.confidence === 'structural') row.confidence = 'structural';
      row.sourceSymbols.add(`${c.symbol}@${c.filePath}`);
    }
  }

  const sorted = [...rows.values()].sort((a, b) =>
    a.library.localeCompare(b.library) || a.updatedVersion.localeCompare(b.updatedVersion, undefined, { numeric: true })
    || a.api.localeCompare(b.api) || a.tag.localeCompare(b.tag));

  const outDir = path.resolve(process.cwd(), ANALYSIS_DIR, 'capturedSymbols');
  OutputJson.createOutputDirectory(outDir);

  // loss_api_list.csv（版ペア × API × タグの1行）
  const csv = ['library,prevVersion,updatedVersion,api,tag,confidence,lossByClientTest,failCount,succCount,sourceSymbols'];
  for (const r of sorted) {
    csv.push([r.library, r.prevVersion, r.updatedVersion, r.api, r.tag, r.confidence,
      r.lossByClientTest, r.failCount, r.succCount, [...r.sourceSymbols].join(' ')].map(toCsvCell).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'loss_api_list.csv'), csv.join('\n') + '\n');

  // by_lib.json（ライブラリごとに API 単位でまとめたもの。どの版ペアでどのタグが付いたか）
  const byLib: Record<string, Record<string, { tags: string[]; pairs: string[] }>> = {};
  for (const r of sorted) {
    const apis = (byLib[r.library] ??= {});
    const a = (apis[r.api] ??= { tags: [], pairs: [] });
    if (!a.tags.includes(r.tag)) a.tags.push(r.tag);
    const pair = `${r.prevVersion}__${r.updatedVersion}`;
    if (!a.pairs.includes(pair)) a.pairs.push(pair);
  }
  fs.writeFileSync(path.join(outDir, 'by_lib.json'), JSON.stringify(byLib, null, 2));

  // dts_gap.csv（.d.ts 宣言のうち surface が捕捉できなかったもの）
  const dts = readJson(path.resolve(process.cwd(), EXTRACTION_COVERAGE_DIR, 'dts_coverage.json'));
  const dtsGap = ((dts?.records ?? []) as DtsRecord[]).filter(d => d.hasDts && d.missing && d.missing.length > 0);
  const dtsRows = ['lib,version,coverage,missingCount,missing'];
  for (const g of dtsGap) {
    dtsRows.push([g.libName, g.version, g.coverage ?? '', g.missing!.length, g.missing!.join(' ')].map(toCsvCell).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'dts_gap.csv'), dtsRows.join('\n') + '\n');

  // summary.json
  const uniqueApis = new Set(sorted.map(r => `${r.library}|${r.api}`));
  const byTag: Record<string, number> = {};
  for (const r of sorted) byTag[r.tag] = (byTag[r.tag] ?? 0) + 1;
  const summary = {
    generatedAt: new Date().toISOString(),
    apiNotation: 'DIAGNOSE 形式（<lib> / <lib>.name / <lib/sub>）',
    rows: sorted.length,                                   // 版ペア × API × タグ
    pairs: new Set(sorted.map(r => `${r.library}|${r.prevVersion}|${r.updatedVersion}`)).size,
    uniqueApis: uniqueApis.size,                           // ライブラリ × API
    byTag,
    skippedCandidates,                                     // 損失なのにパターンが作れなかった候補数（0 のはず）
    dtsGapVersions: dtsGap.length,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`[capturedSymbols] 損失 API ${summary.rows} 行・版ペア ${summary.pairs}・ユニーク API ${summary.uniqueApis}`
    + `・パターンが作れなかった候補 ${skippedCandidates} → ${outDir}`);
}

// CLI 直接実行時のみ
if (process.argv[1] && /capturedSymbols\.(ts|js)$/.test(process.argv[1])) {
  runCapturedSymbols();
}
