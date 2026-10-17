import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import {
  PATTERNS_PATH, CLIENTS_PATH, TEST_RESULT_PATH, CLIENT_REPOS_BASE,
  CLIENT_DETECT_DIR, DETECT_STANDALONE_LATEST, DETECT_STANDALONE_HISTORY, loadRbcClientSet, hasRepoContent, toCsvCell,
} from '../utils/evalShared';
import { initRunLog, phase, progress, quietly, logEvent, runLogSummary } from '../utils/runLog';
import { extractClientUsage } from './extract/extractUsage';
import { typeAwarePatternMatch } from './match/typeAwarePatternMatch';
import { nodeEngineHits } from './match/nodeEngineMatch';
import { dependencyPath } from './match/dependencyMatch';
import { classifyTestScript } from './match/clientTestStatus';
import type { GeneratedPattern } from '../types/patternTypes';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';
import type { ExtendedDetectionOutput, MatchClientPattern, PatternCount } from '../types/clientDetectTypes';

/** patterns.json の1ペア（runDetection が出力） */
interface PatternRecord {
  npm_pkg: string;
  prevVersion: string;
  updatedVersion: string;
  patterns: GeneratedPattern[];
  skippedTags: string[];
}
/** clients.json の1件（検出入力・結果なし。prepareClients が datasets に生成） */
interface ClientEntry { npm_pkg: string; prevVersion: string; updatedVersion: string; client: string; commitId: string; }
/** test_result.json の1件（採点 GT。検出には使わず採点でのみ参照） */
interface TestResultRow { L__npm_pkg: string; S__nameWithOwner: string; L__version: string; state: 'success' | 'failure'; }

const toDir = (r: PatternRecord) => `${r.npm_pkg}__${r.prevVersion}__${r.updatedVersion}`.replace(/[^a-zA-Z0-9_.@-]/g, '_');

/**
 * 検出結果を分ける3群（ディレクトリ名＝群ラベル。群ごとに独立して集計する）
 *   群は版ペア単位で決まる: 1つの版ペアの成功クライアントは全員 g2 か全員 g3
 */
export const GROUPS = {
  failure: 'g1-failureClient',                           // テスト失敗クライアント（prev 成功 → updated 失敗）
  successInFailedPair: 'g2-successClientInFailedPair',   // 失敗クライアントがいる版ペアのテスト成功クライアント
  successInSuccessPair: 'g3-successClientInSuccessPair', // 全員成功の版ペアのテスト成功クライアント
} as const;
type GroupLabel = typeof GROUPS[keyof typeof GROUPS];
const GROUP_ORDER: GroupLabel[] = [GROUPS.failure, GROUPS.successInFailedPair, GROUPS.successInSuccessPair];

/** 1群の集計（クライアントは版ペアごとに数える＝同一クライアントが複数の版ペアに出ると重複する） */
interface GroupAgg {
  pairs: number;
  scanned: number;              // 走査できた（クローン済み）クライアント数＝母数
  detected: number;             // 検出したクライアント数
  structuralDetected: number;   // structural パターンだけで検出した数
  nodeEngineDetected: number;   // 環境述語（node-engine）で検出した数
  dependencyDetected: number;   // 直接の import が無く、依存の経路（package.json・ロックファイル・registry）だけで検出した数
  inPatternedPairs: number;     // 基準線: パターンのある版ペアに属する走査済みクライアント数
  zone: Record<'shared' | 'bclcOnly', { scanned: number; detected: number }>;
  test: { standard: number; notest: number; noscript: number; noPackagejson: number; valid: number };
  byLib: Map<string, { scanned: number; detected: number; inPatternedPairs: number }>;
}

const newGroupAgg = (): GroupAgg => ({
  pairs: 0, scanned: 0, detected: 0, structuralDetected: 0, nodeEngineDetected: 0, dependencyDetected: 0, inPatternedPairs: 0,
  zone: { shared: { scanned: 0, detected: 0 }, bclcOnly: { scanned: 0, detected: 0 } },
  test: { standard: 0, notest: 0, noscript: 0, noPackagejson: 0, valid: 0 },
  byLib: new Map(),
});

const rate = (d: number, n: number): number | null => (n > 0 ? Number((d / n).toFixed(3)) : null);

/**
 * 実行モードと入出力の指定
 *   batch      : 一括実行（index.ts）から呼ぶ。出力は latest/BC-LC/client-detect（patterns と同居）
 *                前提（clients.json/クローン）が無ければ止めずに skip する
 *   standalone : make client-detect（単体）。出力は latest/BC-LC-detect＋history にスナップショット
 *                参照した patterns を複製し、無い前提は実行を促して終了する
 */
export interface ClientDetectOptions {
  mode?: 'batch' | 'standalone';
  patternsPath?: string;  // patterns.json（ファイル）or それらを含むディレクトリ。既定 = PATTERNS_PATH
  maxLibs?: number;
  outDir?: string;        // 出力先の明示指定（8lib 等を BC-LC-8lib/client-detect に分離するため。既定は mode から決定）
}

/** patterns 入力がファイルなら1件、ディレクトリならその下の *.json を全て集める（lib/ペア個別のパスを気にせず読むため） */
function collectPatternFiles(target: string): string[] {
  const abs = path.resolve(process.cwd(), target);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  };
  walk(abs);
  return out;
}

/**
 * patterns を読み込む。入力: ファイル/ディレクトリ / 出力: 全レコード＋読んだファイル
 *   集約 patterns.json（配列）とペア分割ファイル（単体 PatternRecord）の両方を受ける
 *   同一ディレクトリに集約と分割が同居しても、ペアキーで重複排除して二重計上を防ぐ
 */
function loadPatternRecords(target: string): { records: PatternRecord[]; files: string[] } {
  const files = collectPatternFiles(target);
  const byPair = new Map<string, PatternRecord>();
  const add = (r: PatternRecord) => {
    const k = `${r.npm_pkg}|${r.prevVersion}|${r.updatedVersion}`;
    if (!byPair.has(k)) byPair.set(k, r); // 先勝ち（集約と分割で内容は同一）
  };
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (Array.isArray(data)) data.forEach(add);
    else if (data && Array.isArray(data.patterns)) add(data); // 単一 PatternRecord
  }
  return { records: [...byPair.values()], files };
}

/** 版ペアのライブラリ側の損失判定（records.json 由来） */
interface PairJudgement {
  judgement: 'loss' | 'no_loss' | 'not_analyzed';
  lossTags: string;          // loss の根拠のタグ（重複なし・';' 区切り）。それ以外は ''
  whyLossNotJudged: string;  // not_analyzed の理由（no_exports_extracted / library_clone_failed / no_repository_url 等）。それ以外は ''
}

// records.json の除外理由（reason の各要素）を、意味の読める英語にする
const NOT_ANALYZED_REASON: Record<string, string> = {
  empty: 'no_exports_extracted',          // コードは取れたが export を1件も抽出できない
  'clone-failed': 'library_clone_failed', // ライブラリの clone に失敗
  'no-repo-url': 'no_repository_url',     // npm に repository URL が無い
  'ref-unresolved': 'version_not_found_in_repository', // その版の commit を特定できない
  'build-error': 'surface_extraction_failed',          // checkout はできたが surface の構築で失敗
};

/** records.json の reason（例 "pre(2.1.0):empty / post(3.0.0):empty"・"clone-failed"）を英語の理由にする */
function whyLossNotJudged(reason: string): string {
  return reason.split(' / ').map(part => {
    const m = /^(pre|post)\(([^)]*)\):(.+)$/.exec(part.trim());
    return m ? `${m[1]} ${m[2]}: ${NOT_ANALYZED_REASON[m[3]] ?? m[3]}` : (NOT_ANALYZED_REASON[part.trim()] ?? part.trim());
  }).join(' / ');
}

/**
 * パターンと同じ実行の library-detect/records.json から版ペアごとの損失判定を読む（無ければ空）
 *   patterns ファイルが <base>/patterns/patterns.json なら <base>/library-detect/records.json を見る
 */
function loadJudgements(patternFiles: string[]): { judgements: Map<string, PairJudgement>; unevaluated: PatternRecord[] } {
  const judgements = new Map<string, PairJudgement>();
  const unevaluated: PatternRecord[] = [];
  const recordsPath = patternFiles
    .map(f => path.join(path.dirname(path.dirname(f)), 'library-detect', 'records.json'))
    .find(p => fs.existsSync(p));
  if (!recordsPath) return { judgements, unevaluated };
  for (const r of JSON.parse(fs.readFileSync(recordsPath, 'utf-8')) as any[]) {
    const candidates: { tag: string }[] = r.candidates ?? [];
    const judgement: PairJudgement['judgement'] = r.status !== 'evaluated' ? 'not_analyzed' : candidates.length > 0 ? 'loss' : 'no_loss';
    judgements.set(`${r.npm_pkg}|${r.prevVersion}|${r.updatedVersion}`, {
      judgement,
      lossTags: [...new Set(candidates.map(c => c.tag))].sort().join(';'),
      whyLossNotJudged: judgement === 'not_analyzed' ? whyLossNotJudged(String(r.reason ?? r.status)) : '',
    });
    if (judgement === 'not_analyzed') {
      unevaluated.push({ npm_pkg: r.npm_pkg, prevVersion: r.prevVersion, updatedVersion: r.updatedVersion, patterns: [], skippedTags: [] });
    }
  }
  return { judgements, unevaluated };
}

/** マッチしたパターン群を重複排除して PatternCount[] にする（pattern=EFCR[][]＝1パターン=1ファイル群） */
function countPatterns(matchedPerClient: GeneratedPattern[][]): PatternCount[] {
  const byKey = new Map<string, { calls: ExtractFunctionCallsResult[]; count: number }>();
  for (const pats of matchedPerClient) {
    const seen = new Set<string>();
    for (const p of pats) {
      const key = JSON.stringify(p.calls);
      if (seen.has(key)) continue; // 同一クライアント内の重複は1回
      seen.add(key);
      const e = byKey.get(key) ?? { calls: p.calls, count: 0 };
      e.count++; byKey.set(key, e);
    }
  }
  return [...byKey.values()].map(e => ({ pattern: [e.calls], count: e.count }));
}

/** 検出中の位置（progress.json と errors.jsonl の各行に付ける） */
interface Where { pair: string; group: GroupLabel; pairIndex: number; pairTotal: number }

/**
 * 1バケット（1群×1版ペアのクライアント群）を照合し、検出結果 detect/matchResults を組む
 *   useDependency: コードにも環境にも当たらず、ソースに直接の import も無いクライアントを、依存の経路（dependencyMatch）で検出する
 *   （損失のある版ペア＝パターンがあるときだけ。テストの成否は使わず全群に同じ規則を当てる）
 */
async function detectBucket(patterns: GeneratedPattern[], clients: { client: string; repoDir: string }[], libName: string, where: Where, useDependency = true) {
  const detectedClients: string[] = [];
  const matchResults: MatchClientPattern[] = [];
  const matchedPerClient: GeneratedPattern[][] = [];
  let scanned = 0;
  // 走査できた（クローン済み）クライアントのみ採点対象　未クローンは母数から除外
  const perClientMatched: { client: string; matched: boolean; envMatched: boolean; depMatched: boolean }[] = [];
  // 検出したクライアント × 該当パターンの明細＋test 種別（手確認・検出集合の突合用）
  const detailed: { client: string; test: string; patterns: { tag: string; symbol: string; confidence: string }[] }[] = [];

  const codePatterns = patterns.filter(p => !p.env);   // code-usage（正規表現照合）
  const envPatterns = patterns.filter(p => p.env);     // 環境述語（node-engine 等）

  // 検出したクライアントの test スクリプト分類の内訳。validDetected=実テスト('client')を持つ検出数
  let standardCount = 0, noTestCount = 0, noScriptCount = 0, noPackageJsonCount = 0;

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    progress({ lib: libName, ...where, client: c.client, clientIndex: i + 1, clientTotal: clients.length });
    // パターン0件なら照合しても検出0が確定するので抽出を省く（走査可否は extractClientUsage が null を返す条件と同じ＝中身のある repo か）
    if (patterns.length === 0) {
      if (!hasRepoContent(c.repoDir)) continue;
      scanned++;
      perClientMatched.push({ client: c.client, matched: false, envMatched: false, depMatched: false });
      continue;
    }
    // パース警告などの大量出力は画面に出さず errors.jsonl に回す
    const extracted = await quietly(() => extractClientUsage(c.repoDir, libName));
    if (!extracted) continue; // 未クローン＝走査不能。採点母数に含めない
    scanned++;
    const codeRes = typeAwarePatternMatch(codePatterns, extracted.usageByFile);
    // 環境述語は抽出済みコードでなく client repo の環境ファイル（CI設定/.nvmrc/engines.node 等）を直接読んで判定する（nodeEngineMatch）
    const envMatched = envPatterns.some(p => nodeEngineHits(p.env!, c.repoDir));
    const depVia = useDependency && !codeRes.matched && !envMatched && extracted.usageByFile.length === 0
      ? await dependencyPath(c.repoDir, libName) : null;
    const matched = codeRes.matched || envMatched || depVia !== null; // コード命中・環境命中・依存の経路のどれかで検出
    perClientMatched.push({ client: c.client, matched, envMatched, depMatched: depVia !== null });
    if (matched) {
      detectedClients.push(c.client);
      matchedPerClient.push(codeRes.hits.map(h => h.pattern)); // PatternCount は code 命中のみ集計
      matchResults.push({ client: c.client, pattern: [], detectPattern: codeRes.hits.map(h => h.pattern.calls) });
      const pats: { tag: string; symbol: string; confidence: string }[] =
        codeRes.hits.map(h => ({ tag: String(h.pattern.tag), symbol: h.pattern.symbol, confidence: h.pattern.confidence }));
      if (envMatched) pats.push({ tag: 'node-engine', symbol: '', confidence: 'structural' }); // 環境命中も明細に残す
      if (depVia) pats.push({ tag: 'dependency', symbol: depVia, confidence: 'semantic' });     // 依存の経路（symbol に経路）
      // 検出したクライアントが実テストを持つか分類（standard/no test/no scripts/noPackage.json 以外＝'client'）
      const testStatus = classifyTestScript(c.repoDir);
      if (testStatus === 'standard') standardCount++;
      else if (testStatus === 'no test') noTestCount++;
      else if (testStatus === 'no scripts') noScriptCount++;
      else if (testStatus === 'noPackage.json') noPackageJsonCount++;
      detailed.push({ client: c.client, test: testStatus, patterns: pats });
    }
  }

  const detect: ExtendedDetectionOutput = {
    patterns: countPatterns(matchedPerClient),
    totalClients: detectedClients.length,
    detectedClients,
    scannedDirCount: scanned,
    notestCount: noTestCount, standardCount, noscriptCount: noScriptCount, noPackagejsonCount: noPackageJsonCount,
    // 実テスト('client')を持つ検出数＝全検出 − 非実テスト分類
    validDetectedCount: detectedClients.length - (noTestCount + standardCount + noScriptCount + noPackageJsonCount),
  };
  return { detect, matchResults, perClientMatched, detailed };
}

/**
 * 群ごとの per_library_summary.csv と、全体の per_library_by_group.csv を書く
 *   detection_rate = detected / scanned（g1 では recall と同じ値）
 *   scanned_in_patterned_pairs = パターンが1件以上ある版ペアの走査数、detection_rate_in_patterned_pairs = detected / それ
 *   （パターン0件の版ペアでは検出が起き得ないので detected はすべてパターンのある版ペアに属する）
 */
function writeLibraryCsvs(outBase: string, groups: Map<GroupLabel, GroupAgg>): void {
  const fmt = (d: number, n: number) => (n > 0 ? (d / n).toFixed(3) : '');
  const header = 'library,scanned,detected,undetected,detection_rate,scanned_in_patterned_pairs,detection_rate_in_patterned_pairs';
  const all: string[] = [`group,${header}`];
  const row = (name: string, a: { scanned: number; detected: number; inPatternedPairs: number }) =>
    [name, a.scanned, a.detected, a.scanned - a.detected, fmt(a.detected, a.scanned), a.inPatternedPairs, fmt(a.detected, a.inPatternedPairs)].join(',');
  for (const g of GROUP_ORDER) {
    const agg = groups.get(g)!;
    const rows = [...agg.byLib.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([lib, a]) => row(lib, a));
    rows.push(row('TOTAL', agg));
    const dir = path.join(outBase, g);
    OutputJson.createOutputDirectory(dir);
    fs.writeFileSync(path.join(dir, 'per_library_summary.csv'), [header, ...rows].join('\n') + '\n');
    all.push(...rows.map(r => `${g},${r}`));
  }
  fs.writeFileSync(path.join(outBase, 'per_library_by_group.csv'), all.join('\n') + '\n');
}

/** 版ペアごとの1行（群ごとの per_pair_summary.csv） */
interface PairRow {
  library: string;
  prevVersion: string;
  updatedVersion: string;
  clientsInDataset: number;  // 検出入力でこの群に入るクライアント数（clone の有無を問わない）
  clientsScanned: number;    // clone 済みでコードを照合した数（検出率の分母）
  clientsDetected: number;
  patternsGenerated: number; // 生成したパターン数（環境述語を含む）
  judgement: PairJudgement;
  libraryNotAnalyzed: boolean; // ライブラリ側を解析できず照合しなかった
}

/** 照合しなかったクライアントの理由（照合しなかった数が 0 なら ''） */
function notScannedReason(r: PairRow): string {
  if (r.clientsInDataset - r.clientsScanned === 0) return '';
  return r.libraryNotAnalyzed ? 'library_not_analyzed' : 'not_cloned';
}

/** 検出の状態（上から順に当てはまるもの）。他の列（loss_judgement・patterns_generated 等）と合わせて読む */
function detectionStatus(r: PairRow): string {
  if (r.libraryNotAnalyzed) return 'library_not_analyzed';       // ライブラリ側を解析できず照合しなかった
  if (r.clientsScanned === 0) return 'no_client_cloned';         // クライアントを1件も clone できていない
  if (r.patternsGenerated === 0) return 'no_patterns_generated'; // 損失なしの判定でパターンが0本
  return r.clientsDetected > 0 ? 'detected' : 'none_detected';   // 1件以上検出 / 照合したが0件
}

/** 群ごとの合計（summary.json の pairTable。CSV には合計行を入れない） */
interface PairTableTotals {
  pairs: number;
  pairsLibraryNotAnalyzed: number;
  clientsInDataset: number;
  clientsScanned: number;
  clientsNotScanned: { notCloned: number; libraryNotAnalyzed: number };
  clientsDetected: number;
  byDetectionStatus: Record<string, number>; // 版ペア数
}

/**
 * 群ごとの per_pair_summary.csv と、全体の per_pair_by_group.csv を書く（版ペア × 群の1行・合計行なし）
 *   loss_judgement / loss_tags / why_loss_not_judged = ライブラリ側の損失判定（records.json）
 *   detection_status = 検出側の状態。合計は summary.json の groups.<群>.pairTable に出す
 */
function writePairCsvs(outBase: string, pairRows: Map<GroupLabel, PairRow[]>): Record<string, PairTableTotals> {
  const fmt = (d: number, n: number) => (n > 0 ? (d / n).toFixed(3) : '');
  const header = 'library,prevVersion,updatedVersion,clients_in_dataset,clients_scanned,clients_not_scanned,not_scanned_reason,'
    + 'clients_detected,clients_not_detected,detection_rate,patterns_generated,loss_judgement,loss_tags,why_loss_not_judged,detection_status';
  const row = (r: PairRow) => [r.library, r.prevVersion, r.updatedVersion, r.clientsInDataset, r.clientsScanned,
    r.clientsInDataset - r.clientsScanned, notScannedReason(r), r.clientsDetected, r.clientsScanned - r.clientsDetected,
    fmt(r.clientsDetected, r.clientsScanned), r.patternsGenerated, r.judgement.judgement, r.judgement.lossTags,
    r.judgement.whyLossNotJudged, detectionStatus(r)].map(toCsvCell).join(',');
  const all: string[] = [`client_group,${header}`];
  const totals: Record<string, PairTableTotals> = {};
  for (const g of GROUP_ORDER) {
    const rows = (pairRows.get(g) ?? []).sort((a, b) => a.library.localeCompare(b.library)
      || a.updatedVersion.localeCompare(b.updatedVersion, undefined, { numeric: true }));
    const lines = rows.map(row);
    const dir = path.join(outBase, g);
    OutputJson.createOutputDirectory(dir);
    fs.writeFileSync(path.join(dir, 'per_pair_summary.csv'), [header, ...lines].join('\n') + '\n');
    all.push(...lines.map(l => `${g},${l}`));
    const sum = (f: (r: PairRow) => number) => rows.reduce((n, r) => n + f(r), 0);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[detectionStatus(r)] = (byStatus[detectionStatus(r)] ?? 0) + 1;
    totals[g] = {
      pairs: rows.length,
      pairsLibraryNotAnalyzed: rows.filter(r => r.libraryNotAnalyzed).length,
      clientsInDataset: sum(r => r.clientsInDataset),
      clientsScanned: sum(r => r.clientsScanned),
      clientsNotScanned: {
        notCloned: sum(r => (r.libraryNotAnalyzed ? 0 : r.clientsInDataset - r.clientsScanned)),
        libraryNotAnalyzed: sum(r => (r.libraryNotAnalyzed ? r.clientsInDataset : 0)),
      },
      clientsDetected: sum(r => r.clientsDetected),
      byDetectionStatus: byStatus,
    };
  }
  fs.writeFileSync(path.join(outBase, 'per_pair_by_group.csv'), all.join('\n') + '\n');
  return totals;
}

/** 検出率の平均と中央値（unit ごとの値を同じ重みで扱う） */
interface RateStats { units: number; mean: number | null; median: number | null }

function rateStats(rates: number[]): RateStats {
  if (rates.length === 0) return { units: 0, mean: null, median: null };
  const sorted = [...rates].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { units: rates.length, mean: +(rates.reduce((n, r) => n + r, 0) / rates.length).toFixed(3), median: +median.toFixed(3) };
}

/**
 * ライブラリ単位・版ペア単位の検出率の平均と中央値（summary.json の groups.<群>.averages）
 *   byLibrary: ライブラリごとに 検出 / 走査（そのライブラリの版ペアを合算）を出し、ライブラリを同じ重みで平均
 *   byPair:    版ペアごとの 検出 / 走査 を、版ペアを同じ重みで平均
 *   all = 走査数 > 0 の版ペアすべて / patternedPairs = そのうちパターンが1件以上ある版ペアだけ
 */
function averageRates(rows: PairRow[]) {
  const stats = (target: PairRow[]) => {
    const byLib = new Map<string, { scanned: number; detected: number }>();
    for (const r of target) {
      const a = byLib.get(r.library) ?? { scanned: 0, detected: 0 };
      a.scanned += r.clientsScanned;
      a.detected += r.clientsDetected;
      byLib.set(r.library, a);
    }
    return {
      byLibrary: rateStats([...byLib.values()].map(a => a.detected / a.scanned)),
      byPair: rateStats(target.map(r => r.clientsDetected / r.clientsScanned)),
    };
  };
  const scanned = rows.filter(r => r.clientsScanned > 0);
  const all = stats(scanned);
  const patterned = stats(scanned.filter(r => r.patternsGenerated > 0));
  return {
    byLibrary: { all: all.byLibrary, patternedPairs: patterned.byLibrary },
    byPair: { all: all.byPair, patternedPairs: patterned.byPair },
  };
}

/** 1群の summary（g1 は全員が失敗クライアントで誤検出が存在しないため recall のみ。g2/g3 は検出率） */
function groupSummary(label: GroupLabel, a: GroupAgg): Record<string, unknown> {
  const key = label === GROUPS.failure ? 'recall' : 'detectionRate';
  return {
    pairs: a.pairs,
    scanned: a.scanned,
    detected: a.detected,
    undetected: a.scanned - a.detected,
    [key]: rate(a.detected, a.scanned),
    structuralOnly: { detected: a.structuralDetected, [key]: rate(a.structuralDetected, a.scanned) },
    nodeEngineOnly: { detected: a.nodeEngineDetected },
    dependencyOnly: { detected: a.dependencyDetected }, // 直接の import が無く依存の経路だけで検出
    // 基準線: パターンのある版ペアの全クライアントを検出とみなした場合（＝ライブラリ側でパターンが作れた割合）
    baseline: { inPatternedPairs: a.inPatternedPairs, [key]: rate(a.inPatternedPairs, a.scanned) },
    // パターンのある版ペアだけを母数にした値（照合側の性能）。全体の値 = baseline の値 × これ
    withinPatternedPairs: { scanned: a.inPatternedPairs, detected: a.detected, [key]: rate(a.detected, a.inPatternedPairs) },
    // ゾーン: shared=R-BC も評価するクライアント / bclcOnly=BC-LC だけが評価するクライアント
    byZone: {
      shared: { ...a.zone.shared, [key]: rate(a.zone.shared.detected, a.zone.shared.scanned) },
      bclcOnly: { ...a.zone.bclcOnly, [key]: rate(a.zone.bclcOnly.detected, a.zone.bclcOnly.scanned) },
    },
    testBreakdown: a.test, // 検出クライアントの test 種別内訳（valid=実テストを持つ検出）
  };
}

/** patterns 全ペアを clients に照合して outBase に書き、summary を返す（IO 以外は mode 非依存の共通処理） */
async function detectAll(
  patternRecs: PatternRecord[],
  clientsByPair: Map<string, string[]>,
  stateIdx: Map<string, string>,
  outBase: string,
  maxLibs: number,
  rbcSet: Set<string>, // R-BC が評価したクライアント集合（"lib|client"）。ゾーン分け用
  judgements: Map<string, PairJudgement> = new Map(), // 版ペアの損失判定（records.json）。unevaluated の版ペアは照合しない
) {
  const pairRows = new Map<GroupLabel, PairRow[]>(GROUP_ORDER.map(g => [g, []]));
  const pairKey = (npm: string, prev: string, upd: string) => `${npm}|${prev}|${upd}`;
  const zoneOf = (lib: string, client: string): 'shared' | 'bclcOnly' => (rbcSet.has(`${lib}|${client}`) ? 'shared' : 'bclcOnly');

  const groups = new Map<GroupLabel, GroupAgg>(GROUP_ORDER.map(g => [g, newGroupAgg()]));
  const perPair: Record<string, unknown>[] = [];
  // 検出クライアント集約（1ファイルで全ペアの検出集合を持つ＝後段の検出集合突合を walk 不要にする）
  const detectedIndex: Record<string, unknown>[] = [];

  const libs = [...new Set(patternRecs.map(r => r.npm_pkg))].slice(0, maxLibs);
  const libSet = new Set(libs);
  const targetRecs = patternRecs.filter(r => libSet.has(r.npm_pkg));
  let processed = 0, failedPairs = 0, successOnlyPairs = 0, unevaluatedPairs = 0;

  for (let p = 0; p < targetRecs.length; p++) {
    const rec = targetRecs[p];
    // 検出入力（結果なし）からこのペアの依存クライアントを取得
    const clientList = clientsByPair.get(pairKey(rec.npm_pkg, rec.prevVersion, rec.updatedVersion));
    if (!clientList) continue;

    // GT で群に振り分け（state は test_result からのみ参照）
    //   clients.json の全エントリは dataset の性質上 prev=success が確約されており、
    //   下の sPrev==='success' ゲートは常に真になる冪等な保険。sUpd===undefined も実測 0（両版観測済みのため）。
    const failClients: { client: string; repoDir: string }[] = [];
    const succClients: { client: string; repoDir: string }[] = [];
    for (const cli of clientList) {
      const sPrev = stateIdx.get(`${rec.npm_pkg}|${cli}|${rec.prevVersion}`);
      const sUpd = stateIdx.get(`${rec.npm_pkg}|${cli}|${rec.updatedVersion}`);
      if (sPrev !== 'success' || sUpd === undefined) continue;
      const repoDir = path.resolve(process.cwd(), CLIENT_REPOS_BASE, rec.npm_pkg, cli);
      (sUpd === 'failure' ? failClients : succClients).push({ client: cli, repoDir });
    }
    if (failClients.length === 0 && succClients.length === 0) continue;

    const pairHasFailure = failClients.length > 0;
    const judged: PairJudgement = judgements.get(pairKey(rec.npm_pkg, rec.prevVersion, rec.updatedVersion))
      ?? { judgement: rec.patterns.length > 0 ? 'loss' : 'no_loss', lossTags: [...new Set(rec.patterns.map(pt => String(pt.tag)))].sort().join(';'), whyLossNotJudged: '' };
    // ライブラリ側を解析できなかった版ペアは照合せず、版ペアの行だけ残す（recall の母数には入れない）
    if (judged.judgement === 'not_analyzed') {
      const grp = (cs: unknown[], g: GroupLabel) => {
        if (cs.length > 0) pairRows.get(g)!.push({ library: rec.npm_pkg, prevVersion: rec.prevVersion, updatedVersion: rec.updatedVersion,
          clientsInDataset: cs.length, clientsScanned: 0, clientsDetected: 0, patternsGenerated: 0, judgement: judged, libraryNotAnalyzed: true });
      };
      grp(failClients, GROUPS.failure);
      grp(succClients, pairHasFailure ? GROUPS.successInFailedPair : GROUPS.successInSuccessPair);
      unevaluatedPairs++;
      continue;
    }
    if (pairHasFailure) failedPairs++; else successOnlyPairs++;
    const structPatterns = rec.patterns.filter(pt => pt.confidence === 'structural');
    const hasPatterns = rec.patterns.length > 0;
    const pair = toDir(rec);
    const pairType = pairHasFailure ? 'failed-pair' : 'success-only-pair';

    // 失敗クライアント → g1、成功クライアント → 版ペアに失敗者がいれば g2・いなければ g3
    const buckets = [
      { group: GROUPS.failure as GroupLabel, prefix: 'failure', clients: failClients },
      { group: (pairHasFailure ? GROUPS.successInFailedPair : GROUPS.successInSuccessPair) as GroupLabel, prefix: 'success', clients: succClients },
    ].filter(b => b.clients.length > 0);

    const perPairEntry: Record<string, unknown> = { pair, pairType, patternCount: rec.patterns.length };
    const indexGroups: Record<string, unknown> = {};
    for (const b of buckets) {
      const where: Where = { pair, group: b.group, pairIndex: p + 1, pairTotal: targetRecs.length };
      const res = await detectBucket(rec.patterns, b.clients, rec.npm_pkg, where);
      const resS = await detectBucket(structPatterns, b.clients, rec.npm_pkg, where, false);

      // 群ディレクトリ配下に版ペアごとの検出結果（ファイル名は従来どおり failure_/success_ ＝ changeversion と同じ命名）
      const dir = path.join(outBase, b.group, pair);
      OutputJson.createOutputDirectory(dir);
      fs.writeFileSync(path.join(dir, `${b.prefix}_detect.json`), JSON.stringify(res.detect, null, 2));
      fs.writeFileSync(path.join(dir, `${b.prefix}_matchResults.json`), JSON.stringify(res.matchResults, null, 2));

      const agg = groups.get(b.group)!;
      agg.pairs++;
      agg.scanned += res.detect.scannedDirCount;
      agg.detected += res.detect.totalClients;
      agg.structuralDetected += resS.detect.totalClients;
      agg.nodeEngineDetected += res.perClientMatched.filter(c => c.envMatched).length;
      agg.dependencyDetected += res.perClientMatched.filter(c => c.depMatched).length;
      if (hasPatterns) agg.inPatternedPairs += res.detect.scannedDirCount;
      for (const c of res.perClientMatched) {
        const z = agg.zone[zoneOf(rec.npm_pkg, c.client)];
        z.scanned++;
        if (c.matched) z.detected++;
      }
      agg.test.standard += res.detect.standardCount;
      agg.test.notest += res.detect.notestCount;
      agg.test.noscript += res.detect.noscriptCount;
      agg.test.noPackagejson += res.detect.noPackagejsonCount;
      agg.test.valid += res.detect.validDetectedCount;
      const libAgg = agg.byLib.get(rec.npm_pkg) ?? { scanned: 0, detected: 0, inPatternedPairs: 0 };
      libAgg.scanned += res.detect.scannedDirCount;
      libAgg.detected += res.detect.totalClients;
      if (hasPatterns) libAgg.inPatternedPairs += res.detect.scannedDirCount;
      agg.byLib.set(rec.npm_pkg, libAgg);

      perPairEntry[b.group] = { scanned: res.detect.scannedDirCount, detected: res.detect.totalClients };
      pairRows.get(b.group)!.push({
        library: rec.npm_pkg, prevVersion: rec.prevVersion, updatedVersion: rec.updatedVersion,
        clientsInDataset: b.clients.length, clientsScanned: res.detect.scannedDirCount, clientsDetected: res.detect.totalClients,
        patternsGenerated: rec.patterns.length, judgement: judged, libraryNotAnalyzed: false,
      });
      // 各 hit に zone（shared / bclcOnly）を付けて R-BC との突合・ゾーン別集計をしやすくする
      indexGroups[b.group] = {
        scanned: res.detect.scannedDirCount,
        detectedClients: res.detect.detectedClients,
        hits: res.detailed.map(h => ({ ...h, zone: zoneOf(rec.npm_pkg, h.client) })),
      };
    }
    perPair.push(perPairEntry);
    detectedIndex.push({
      npm_pkg: rec.npm_pkg, prevVersion: rec.prevVersion, updatedVersion: rec.updatedVersion,
      pair, pairType, patternCount: rec.patterns.length, groups: indexGroups,
    });

    if (++processed % 100 === 0) process.stderr.write(`\r  pairs: ${processed}`);
  }
  process.stderr.write('\n');

  // 検出クライアント集約を1ファイルで（後段の検出集合突合が walk 不要で済む）
  fs.writeFileSync(path.join(outBase, 'detected_clients.json'), JSON.stringify(detectedIndex, null, 2));
  writeLibraryCsvs(outBase, groups);
  const pairTables = writePairCsvs(outBase, pairRows);

  return {
    generatedAt: new Date().toISOString(),
    countingUnit: 'クライアント×版ペア（同一クライアントが複数の版ペアに出ると重複して数える）',
    // unevaluatedPairs = ライブラリ側を解析できず照合しなかった版ペア（per_pair_summary.csv の detection_status=library_not_analyzed）
    coverage: { patternPairs: patternRecs.length - unevaluatedPairs, libsProcessed: libs.length, evaluatedPairs: perPair.length, failedPairs, successOnlyPairs, unevaluatedPairs },
    // pairTable = per_pair_summary.csv の合計（照合しなかった版ペア・クライアントも含めた数）
    // averages = ライブラリ単位・版ペア単位の平均と中央値（上の recall / detectionRate はクライアント単位の合算）
    groups: Object.fromEntries(GROUP_ORDER.map(g => [g, {
      ...groupSummary(g, groups.get(g)!), averages: averageRates(pairRows.get(g) ?? []), pairTable: pairTables[g],
    }])),
    perPair,
  };
}

export async function runClientDetect(opts: ClientDetectOptions = {}): Promise<void> {
  const mode = opts.mode ?? 'standalone';
  const maxLibs = opts.maxLibs ?? Infinity;
  const patternsInput = opts.patternsPath ?? PATTERNS_PATH;
  phase('client-detect');

  // patterns を読む（ファイル/ディレクトリどちらでも可）
  const { records: patternRecs, files: patternFiles } = loadPatternRecords(patternsInput);
  if (patternRecs.length === 0) {
    const msg = `[client-detect] patterns が空/未検出: ${path.resolve(process.cwd(), patternsInput)}`;
    logEvent('error', msg);
    if (mode === 'batch') { console.warn(`${msg}（先に検出/生成を実行）→ skip`); return; }
    console.error(`${msg}（先に make run または make detect でパターン生成）`); process.exit(1);
  }

  // 検出入力（結果なし・事前用意）を datasets から読む。無ければ実行を促す
  const clientsPath = path.resolve(process.cwd(), CLIENTS_PATH);
  if (!fs.existsSync(clientsPath)) {
    const msg = `[client-detect] 検出入力が無い: ${clientsPath}（make setup または make prepare-clients で生成）`;
    logEvent('error', msg);
    if (mode === 'batch') { console.warn(`${msg} → client-detect を skip`); return; }
    console.error(msg); process.exit(1);
  }
  const clientEntries: ClientEntry[] = JSON.parse(fs.readFileSync(clientsPath, 'utf-8'));

  // 検出入力の索引（結果を含まない）: pairKey -> client[]
  const pairKey = (npm: string, prev: string, upd: string) => `${npm}|${prev}|${upd}`;
  const clientsByPair = new Map<string, string[]>();
  for (const c of clientEntries) {
    const k = pairKey(c.npm_pkg, c.prevVersion, c.updatedVersion);
    (clientsByPair.get(k) ?? clientsByPair.set(k, []).get(k)!).push(c.client);
  }

  // 採点 GT: 元の test_result.json を直接参照（派生コピーを作らない）。state[lib|client|version]
  const testResult: TestResultRow[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), TEST_RESULT_PATH), 'utf-8'));
  const stateIdx = new Map<string, string>();
  for (const r of testResult) stateIdx.set(`${r.L__npm_pkg}|${r.S__nameWithOwner}|${r.L__version}`, r.state);

  // R-BC が評価したクライアント集合（alldataset_clients）。ゾーン分け（shared / bclcOnly）に使う
  const rbcSet = loadRbcClientSet();
  if (rbcSet.size === 0) {
    console.warn('[client-detect] alldataset_clients が見つからず zone 分けは全て bclcOnly 扱い');
    logEvent('warn', 'alldataset_clients が見つからず zone 分けは全て bclcOnly 扱い');
  }

  // 出力先: outDir 明示指定が最優先（8lib を BC-LC-8lib/client-detect に分離）/ 無ければ batch=client-detect・standalone=BC-LC-detect
  //   群別ディレクトリに作り直すので、前回の残骸（旧レイアウト含む）はどのモードでも掃除する
  const outBase = path.resolve(process.cwd(), opts.outDir ?? (mode === 'batch' ? CLIENT_DETECT_DIR : DETECT_STANDALONE_LATEST));
  fs.rmSync(outBase, { recursive: true, force: true });
  OutputJson.createOutputDirectory(outBase);

  const { judgements, unevaluated } = loadJudgements(patternFiles);
  const known = new Set(patternRecs.map(r => `${r.npm_pkg}|${r.prevVersion}|${r.updatedVersion}`));
  const allRecs = [...patternRecs, ...unevaluated.filter(r => !known.has(`${r.npm_pkg}|${r.prevVersion}|${r.updatedVersion}`))];
  const summary = await detectAll(allRecs, clientsByPair, stateIdx, outBase, maxLibs, rbcSet, judgements);
  fs.writeFileSync(path.join(outBase, 'summary.json'), JSON.stringify(summary, null, 2));

  // 参照した patterns の出所を記録。standalone は patterns 実体も複製して「検出結果とパターン」を一緒に残す
  const resolvedPatternFiles = patternFiles.map(f => path.relative(process.cwd(), f));
  fs.writeFileSync(path.join(outBase, 'source.json'), JSON.stringify(
    { mode, patternsInput: path.relative(process.cwd(), path.resolve(process.cwd(), patternsInput)),
      patternFiles: resolvedPatternFiles, patternRecordCount: patternRecs.length, generatedAt: summary.generatedAt },
    null, 2));
  if (mode === 'standalone') {
    fs.writeFileSync(path.join(outBase, 'patterns_used.json'), JSON.stringify(patternRecs, null, 2));
    // 日時スナップショットを history に退避（latest は最新のみ・history はパターンごと積む）。
    // outDir 明示時（8lib 等）は呼び出し側が history を作るのでここでは積まない
    if (!opts.outDir) {
      const stamp = process.env.BCPG_RUN_ID ?? OutputJson.formatDateTime(new Date()); // make 経由なら実行ログと同じ RUN_ID
      const hist = path.resolve(process.cwd(), DETECT_STANDALONE_HISTORY, stamp);
      fs.mkdirSync(path.dirname(hist), { recursive: true });
      fs.cpSync(outBase, hist, { recursive: true });
      console.log(`[Archive] 単体検出を保存 → ${hist}`);
    }
  }

  console.log(`[Done] client-detect (${mode}) → ${outBase}`);
  for (const g of GROUP_ORDER) {
    const s = summary.groups[g] as Record<string, any>;
    const key = g === GROUPS.failure ? 'recall' : 'detectionRate';
    console.log(`  ${g.padEnd(30)}: 検出 ${s.detected}/${s.scanned} ${key}=${s[key] ?? '-'}` +
      `（structural ${s.structuralOnly.detected} / node-engine ${s.nodeEngineOnly.detected} / 依存経路 ${s.dependencyOnly.detected}）` +
      ` ｜ パターンあり版ペア内 ${s.detected}/${s.withinPatternedPairs.scanned}=${s.withinPatternedPairs[key] ?? '-'}`);
  }
  const { dir, counts } = runLogSummary();
  if (dir) console.log(`  実行ログ(累計): error ${counts.error} / warn ${counts.warn} / log ${counts.log} → ${dir}`);
}

// CLI 直接実行時のみ（import 時は走らせない）＝ make client-detect（単体）
//   引数: [patternsPathOrDir] [maxLibs]（数値のみの引数は maxLibs 扱い・順不同）
if (process.argv[1] && /runClientDetect\.(ts|js)$/.test(process.argv[1])) {
  initRunLog('client-detect');
  const args = process.argv.slice(2);
  let patternsPath: string | undefined;
  let maxLibs = Infinity;
  for (const a of args) {
    if (/^\d+$/.test(a)) maxLibs = Number(a);
    else patternsPath = a;
  }
  runClientDetect({ mode: 'standalone', patternsPath, maxLibs })
    .catch(e => { logEvent('error', `[Fatal] ${e?.stack ?? e}`); console.error('[Fatal]', e); process.exit(1); });
}
