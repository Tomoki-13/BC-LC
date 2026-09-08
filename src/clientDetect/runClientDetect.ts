import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import {
  computeMetrics, PATTERNS_PATH, CLIENTS_PATH, TEST_RESULT_PATH, CLIENT_REPOS_BASE,
  CLIENT_DETECT_DIR, DETECT_STANDALONE_LATEST, DETECT_STANDALONE_HISTORY,
} from '../utils/evalShared';
import { extractClientUsage } from './extract/extractUsage';
import { typeAwarePatternMatch } from './match/typeAwarePatternMatch';
import { nodeEngineHits } from './match/nodeEngineMatch';
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

/** 1バケット（state 別クライアント群）を照合し、検出結果 detect/matchResults を組む */
async function detectBucket(patterns: GeneratedPattern[], clients: { client: string; repoDir: string }[], libName: string) {
  const detectedClients: string[] = [];
  const matchResults: MatchClientPattern[] = [];
  const matchedPerClient: GeneratedPattern[][] = [];
  let scanned = 0;
  // 走査できた（クローン済み）クライアントのみ採点対象　未クローンは母数から除外
  const perClientMatched: { client: string; matched: boolean; envMatched: boolean }[] = [];
  // 検出したクライアント × 該当パターンの明細＋test 種別（手確認・検出集合の突合用）
  const detailed: { client: string; test: string; patterns: { tag: string; symbol: string; confidence: string }[] }[] = [];

  const codePatterns = patterns.filter(p => !p.env);   // code-usage（正規表現照合）
  const envPatterns = patterns.filter(p => p.env);     // 環境述語（node-engine 等）

  // 検出したクライアントの test スクリプト分類の内訳。validDetected=実テスト('client')を持つ検出数
  let standardCount = 0, noTestCount = 0, noScriptCount = 0, noPackageJsonCount = 0;

  for (const c of clients) {
    const extracted = await extractClientUsage(c.repoDir, libName);
    if (!extracted) continue; // 未クローン＝走査不能。採点母数に含めない
    scanned++;
    const codeRes = typeAwarePatternMatch(codePatterns, extracted.usageByFile);
    // 環境述語は抽出済みコードでなく client repo の環境ファイル（CI設定/.nvmrc/engines.node 等）を直接読んで判定する（nodeEngineMatch）
    const envMatched = envPatterns.some(p => nodeEngineHits(p.env!, c.repoDir));
    const matched = codeRes.matched || envMatched; // コード命中 or 環境命中のどちらかで検出
    perClientMatched.push({ client: c.client, matched, envMatched });
    if (matched) {
      detectedClients.push(c.client);
      matchedPerClient.push(codeRes.hits.map(h => h.pattern)); // PatternCount は code 命中のみ集計
      matchResults.push({ client: c.client, pattern: [], detectPattern: codeRes.hits.map(h => h.pattern.calls) });
      const pats: { tag: string; symbol: string; confidence: string }[] =
        codeRes.hits.map(h => ({ tag: String(h.pattern.tag), symbol: h.pattern.symbol, confidence: h.pattern.confidence }));
      if (envMatched) pats.push({ tag: 'node-engine', symbol: '', confidence: 'structural' }); // 環境命中も明細に残す
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

/** patterns 全ペアを clients に照合して outBase に書き、summary を返す（IO 以外は mode 非依存の共通処理） */
async function detectAll(
  patternRecs: PatternRecord[],
  clientsByPair: Map<string, string[]>,
  stateIdx: Map<string, string>,
  outBase: string,
  maxLibs: number,
) {
  const pairKey = (npm: string, prev: string, upd: string) => `${npm}|${prev}|${upd}`;

  // 採点用の混同行列（クライアント単位。正例=prev成功→updated失敗）
  const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const cmStruct = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const cmLibBase = { tp: 0, fp: 0, fn: 0, tn: 0 }; // 破壊ペアの全クライアントを壊れ予測（基準線）
  const cmNodeEngine = { tp: 0, fp: 0, fn: 0, tn: 0 }; // node-engine 環境述語のみ（env パターンを持つペア限定）
  const perPair: any[] = [];
  // 検出クライアント集約（1ファイルで全ペアの検出集合を持つ＝後段の検出集合突合を walk 不要にする）
  const detectedIndex: any[] = [];
  // 検出クライアントの test 種別の全体内訳（valid=実テスト'client'を持つ検出。破壊を実際に捕まえうる）
  const testAgg = {
    failure: { standard: 0, notest: 0, noscript: 0, noPackagejson: 0, valid: 0 },
    success: { standard: 0, notest: 0, noscript: 0, noPackagejson: 0, valid: 0 },
  };

  const libs = [...new Set(patternRecs.map(r => r.npm_pkg))].slice(0, maxLibs);
  const libSet = new Set(libs);
  let processed = 0;

  for (const rec of patternRecs) {
    if (!libSet.has(rec.npm_pkg)) continue;
    // 検出入力（結果なし）からこのペアの依存クライアントを取得
    const clientList = clientsByPair.get(pairKey(rec.npm_pkg, rec.prevVersion, rec.updatedVersion));
    if (!clientList) continue;

    // GT バケットに振り分け（採点母数＝prev で成功したもの＝この遷移に帰属可能。state は test_result からのみ参照）
    //   clients.json は結果フリー（state を持たない）。prev 成功の条件を clients.json 側で再構成しようとしないこと。
    //   なお clients.json の全エントリは dataset の性質上 prev=success が確約されており（prepareClients のコメント参照）、
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

    const structPatterns = rec.patterns.filter(p => p.confidence === 'structural');
    const hasPatterns = rec.patterns.length > 0;

    const fail = await detectBucket(rec.patterns, failClients, rec.npm_pkg);
    const succ = await detectBucket(rec.patterns, succClients, rec.npm_pkg);
    const failS = await detectBucket(structPatterns, failClients, rec.npm_pkg);
    const succS = await detectBucket(structPatterns, succClients, rec.npm_pkg);

    // 検出結果ファイルを出力（*_detect.json＝集計 / *_matchResults.json＝命中記録）
    const dir = path.join(outBase, toDir(rec));
    OutputJson.createOutputDirectory(dir);
    fs.writeFileSync(path.join(dir, 'failure_detect.json'), JSON.stringify(fail.detect, null, 2));
    fs.writeFileSync(path.join(dir, 'failure_matchResults.json'), JSON.stringify(fail.matchResults, null, 2));
    fs.writeFileSync(path.join(dir, 'success_detect.json'), JSON.stringify(succ.detect, null, 2));
    fs.writeFileSync(path.join(dir, 'success_matchResults.json'), JSON.stringify(succ.matchResults, null, 2));

    // 採点: failure バケットで命中=TP/非命中=FN、success バケットで命中=FP/非命中=TN
    const tally = (m: typeof cm, failRes: typeof fail, succRes: typeof succ) => {
      for (const c of failRes.perClientMatched) { if (c.matched) m.tp++; else m.fn++; }
      for (const c of succRes.perClientMatched) { if (c.matched) m.fp++; else m.tn++; }
    };
    tally(cm, fail, succ);
    tally(cmStruct, failS, succS);
    // 基準線: 走査できたクライアントは全員「破壊ペアなら壊れ」と予測（pattern-level と同じ母数）
    for (const _ of fail.perClientMatched) (hasPatterns ? cmLibBase.tp++ : cmLibBase.fn++);
    for (const _ of succ.perClientMatched) (hasPatterns ? cmLibBase.fp++ : cmLibBase.tn++);
    // node-engine 単独採点（env パターンを持つペアのみ・環境予測 envMatched で判定）
    if (rec.patterns.some(p => p.env)) {
      for (const c of fail.perClientMatched) { if (c.envMatched) cmNodeEngine.tp++; else cmNodeEngine.fn++; }
      for (const c of succ.perClientMatched) { if (c.envMatched) cmNodeEngine.fp++; else cmNodeEngine.tn++; }
    }

    perPair.push({
      pair: toDir(rec), patternCount: rec.patterns.length,
      failure: { scanned: fail.detect.scannedDirCount, detected: fail.detect.totalClients },
      success: { scanned: succ.detect.scannedDirCount, detected: succ.detect.totalClients },
    });
    // 全ペア横断の検出集合（failure=正例側・success=負例側それぞれの検出クライアントと該当パターン明細）
    detectedIndex.push({
      npm_pkg: rec.npm_pkg, prevVersion: rec.prevVersion, updatedVersion: rec.updatedVersion, pair: toDir(rec),
      patternCount: rec.patterns.length,
      failure: { scanned: fail.detect.scannedDirCount, detectedClients: fail.detect.detectedClients, hits: fail.detailed },
      success: { scanned: succ.detect.scannedDirCount, detectedClients: succ.detect.detectedClients, hits: succ.detailed },
    });
    // test 種別を全体に加算（fail/succ バケットの detect カウンタから）
    const addTest = (agg: typeof testAgg.failure, d: ExtendedDetectionOutput) => {
      agg.standard += d.standardCount; agg.notest += d.notestCount;
      agg.noscript += d.noscriptCount; agg.noPackagejson += d.noPackagejsonCount; agg.valid += d.validDetectedCount;
    };
    addTest(testAgg.failure, fail.detect);
    addTest(testAgg.success, succ.detect);

    if (++processed % 100 === 0) process.stderr.write(`\r  pairs: ${processed}`);
  }
  process.stderr.write('\n');

  // 検出クライアント集約を1ファイルで（後段の検出集合突合が walk 不要で済む）
  fs.writeFileSync(path.join(outBase, 'detected_clients.json'), JSON.stringify(detectedIndex, null, 2));

  return {
    generatedAt: new Date().toISOString(),
    coverage: { patternPairs: patternRecs.length, libsProcessed: libs.length, evaluatedPairs: perPair.length,
      positives: cm.tp + cm.fn, negatives: cm.fp + cm.tn },
    libraryLevel: { ...cmLibBase, ...computeMetrics(cmLibBase) },
    patternLevel: { ...cm, ...computeMetrics(cm) },
    patternLevel_structuralOnly: { ...cmStruct, ...computeMetrics(cmStruct) },
    nodeEngine: { ...cmNodeEngine, ...computeMetrics(cmNodeEngine) }, // env 述語のみ（node-npm ペア限定）
    testBreakdown: testAgg, // 検出クライアントの test 種別内訳（valid=実テストを持つ検出）
    perPair,
    _cm: { cm, cmStruct, cmNodeEngine, cmLibBase }, // ログ表示用（summary.json には出さない）
  };
}

export async function runClientDetect(opts: ClientDetectOptions = {}): Promise<void> {
  const mode = opts.mode ?? 'standalone';
  const maxLibs = opts.maxLibs ?? Infinity;
  const patternsInput = opts.patternsPath ?? PATTERNS_PATH;

  // patterns を読む（ファイル/ディレクトリどちらでも可）
  const { records: patternRecs, files: patternFiles } = loadPatternRecords(patternsInput);
  if (patternRecs.length === 0) {
    const msg = `[client-detect] patterns が空/未検出: ${path.resolve(process.cwd(), patternsInput)}`;
    if (mode === 'batch') { console.warn(`${msg}（先に検出/生成を実行）→ skip`); return; }
    console.error(`${msg}（先に make run または make detect でパターン生成）`); process.exit(1);
  }

  // 検出入力（結果なし・事前用意）を datasets から読む。無ければ実行を促す
  const clientsPath = path.resolve(process.cwd(), CLIENTS_PATH);
  if (!fs.existsSync(clientsPath)) {
    const msg = `[client-detect] 検出入力が無い: ${clientsPath}（make setup または make prepare-clients で生成）`;
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

  // 出力先: batch=一括の client-detect（patterns と同居）/ standalone=BC-LC-detect（別木・毎回入れ替え）
  const outBase = path.resolve(process.cwd(), mode === 'batch' ? CLIENT_DETECT_DIR : DETECT_STANDALONE_LATEST);
  if (mode === 'standalone') fs.rmSync(outBase, { recursive: true, force: true }); // 前回の残骸で history が混ざらないよう掃除
  OutputJson.createOutputDirectory(outBase);

  const summary = await detectAll(patternRecs, clientsByPair, stateIdx, outBase, maxLibs);
  const { _cm, ...summaryOut } = summary;
  fs.writeFileSync(path.join(outBase, 'summary.json'), JSON.stringify(summaryOut, null, 2));

  // 参照した patterns の出所を記録。standalone は patterns 実体も複製して「検出結果とパターン」を一緒に残す
  const resolvedPatternFiles = patternFiles.map(f => path.relative(process.cwd(), f));
  fs.writeFileSync(path.join(outBase, 'source.json'), JSON.stringify(
    { mode, patternsInput: path.relative(process.cwd(), path.resolve(process.cwd(), patternsInput)),
      patternFiles: resolvedPatternFiles, patternRecordCount: patternRecs.length, generatedAt: summaryOut.generatedAt },
    null, 2));
  if (mode === 'standalone') {
    fs.writeFileSync(path.join(outBase, 'patterns_used.json'), JSON.stringify(patternRecs, null, 2));
    // 日時スナップショットを history に退避（latest は最新のみ・history はパターンごと積む）
    const stamp = OutputJson.formatDateTime(new Date());
    const hist = path.resolve(process.cwd(), DETECT_STANDALONE_HISTORY, stamp);
    fs.mkdirSync(path.dirname(hist), { recursive: true });
    fs.cpSync(outBase, hist, { recursive: true });
    console.log(`[Archive] 単体検出を保存 → ${hist}`);
  }

  const { cm, cmStruct, cmNodeEngine, cmLibBase } = _cm;
  console.log(`[Done] client-detect (${mode}) → ${outBase}`);
  console.log(`  pattern-level : P=${summaryOut.patternLevel.precision} R=${summaryOut.patternLevel.recall} F1=${summaryOut.patternLevel.f1} (tp${cm.tp} fp${cm.fp} fn${cm.fn} tn${cm.tn})`);
  console.log(`  structural    : P=${summaryOut.patternLevel_structuralOnly.precision} R=${summaryOut.patternLevel_structuralOnly.recall} F1=${summaryOut.patternLevel_structuralOnly.f1}`);
  console.log(`  node-engine   : P=${summaryOut.nodeEngine.precision} R=${summaryOut.nodeEngine.recall} F1=${summaryOut.nodeEngine.f1} (tp${cmNodeEngine.tp} fp${cmNodeEngine.fp} fn${cmNodeEngine.fn} tn${cmNodeEngine.tn})`);
  console.log(`  library-base  : P=${summaryOut.libraryLevel.precision} R=${summaryOut.libraryLevel.recall} F1=${summaryOut.libraryLevel.f1}`);
}

// CLI 直接実行時のみ（import 時は走らせない）＝ make client-detect（単体）
//   引数: [patternsPathOrDir] [maxLibs]（数値のみの引数は maxLibs 扱い・順不同）
if (process.argv[1] && /runClientDetect\.(ts|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  let patternsPath: string | undefined;
  let maxLibs = Infinity;
  for (const a of args) {
    if (/^\d+$/.test(a)) maxLibs = Number(a);
    else patternsPath = a;
  }
  runClientDetect({ mode: 'standalone', patternsPath, maxLibs })
    .catch(e => { console.error('[Fatal]', e); process.exit(1); });
}
