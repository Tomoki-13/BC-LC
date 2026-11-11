import fs from 'fs';
import path from 'path';
import OutputJson from './output_json';
import ApiSurface from '../libDiff/apiSurface';
import LibRepo from '../libDiff/libRepo';
import type { ApiSurface as ApiSurfaceType, ApiUsage } from '../types/LibDiff';
import type { GeneratedPattern } from '../types/patternTypes';
import { RUN_VARIANT } from './runVariant';

// eval 系スクリプトが共有する入出力パス（process.cwd() = BC-LC/src 基準）
export const CLONE_BASE = '../../clonedata/lib_versions';
// 一括実行の出力はモードごとのフォルダ（latest/BC-LC/<scope-…_detect-…>/）。同じモードの実行だけが上書きする
//   results/    評価の値
//   discussion/ 確認用の材料
//   work/       途中データ（次の段の入力）
//   changever/  changeversion（ClientFixTrace）の入力と同じ形（R-BC の method/<lib>_<verKey>/ と同じ並び）
//   audit/      バージョン解決などの監査ログ
export const RUN_OUTPUT_BASE = `../../outputs/latest/BC-LC/${RUN_VARIANT}`;
const OUTPUT_BASE = RUN_OUTPUT_BASE;
const RESULTS_DIR = `${OUTPUT_BASE}/results`;
const DISCUSSION_DIR = `${OUTPUT_BASE}/discussion`;
const WORK_DIR = `${OUTPUT_BASE}/work`;
export const LIBRARY_DETECT_DIR = `${WORK_DIR}/library-detect`; // ライブラリ側の損失有無検出（client-detect と対）
export const PATTERNS_DIR = `${WORK_DIR}/patterns`; // 損失候補 → R-BC 形式の検出パターン（client-detect の照合入力）
export const SURFACE_DIR = `${WORK_DIR}/surface`;   // 損失判定に使った pre/post の API surface（<lib>/<upd>/{pre,post,diff}.json）
export const LOSS_JUDGEMENT_DIR = `${RESULTS_DIR}/loss-judgement`;            // 損失判定の採点（混同行列・版ペアごとの判定）
export const CLIENT_DETECT_DIR = `${RESULTS_DIR}/client-detection`;           // 一括実行時の照合結果（群ごとの集計・版ペアごとの detect.json）
export const EXTRACTION_COVERAGE_DIR = `${RESULTS_DIR}/extraction-coverage`;  // .d.ts と比べた surface 抽出の網羅率
export const LOSS_DISCUSSION_DIR = `${DISCUSSION_DIR}/loss-judgement`;        // タグ別 TP/FP・除外した版ペア
export const CLIENT_DISCUSSION_DIR = `${DISCUSSION_DIR}/client-detection`;    // 検出の明細・クライアントごとの補足情報
export const SCOPE_COMPARE_DIR = `${DISCUSSION_DIR}/scope-compare`;           // API の範囲ごとの損失判定の比較
export const CHANGEVER_DIR = `${OUTPUT_BASE}/changever`;                      // changeversion の入力と同じ形
// 単体 client-detect の出力（一括の BC-LC を上書きしない別木）。latest は毎回入れ替え・history に日時スナップショット
export const DETECT_STANDALONE_LATEST = '../../outputs/latest/BC-LC-detect';
export const DETECT_STANDALONE_HISTORY = '../../outputs/history/BC-LC-detect';
export const CLIENT_REPOS_BASE = '../../clonedata/clientRepos'; // クライアント repo クローン（<lib>/<owner>/<repo>）
export const REGISTRY_DEPS_CACHE = '../../clonedata/registry-deps'; // npm registry の依存情報キャッシュ（<name>.json＝版→dependencies）

/** クライアント repo がクローン済みか（.git 以外の中身がある）。空ディレクトリ・.git だけのディレクトリは未クローン扱い */
export function hasRepoContent(repoDir: string): boolean {
  try {
    return fs.readdirSync(repoDir).some(name => name !== '.git');
  } catch {
    return false;
  }
}
/**
 * クローンの HEAD のコミット（.git を直接読む・git を起動しない）。読めなければ null
 *   検出の前に「テストしたときのコミットか」を数千件まとめて確かめるため、git rev-parse を使わない
 */
export function readHeadCommit(repoDir: string): string | null {
  try {
    const gitDir = path.join(repoDir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (!head.startsWith('ref: ')) return head; // detached（setup が commitId に checkout した状態）
    const ref = head.slice('ref: '.length);
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf-8').trim();
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf-8');
    const line = packed.split('\n').find(l => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : null;
  } catch {
    return null;
  }
}

/** クローンの HEAD がテストしたときのコミット（commitId）か */
export function isAtCommit(repoDir: string, commitId: string): boolean {
  const head = readHeadCommit(repoDir);
  return !!head && !!commitId && head.toLowerCase().startsWith(commitId.toLowerCase());
}
export const ALLDATASET_CLIENTS_BASE = '../../clonedata/alldataset_clients'; // R-BC のクライアント実体（<lib>/<ver>/<state>/<owner>/<repo>）
export const TEST_RESULT_PATH = '../../datasets/test_result.json'; // 採点の GT（L 版 × S repo → 合否）。検出入力には使わない
export const CLIENTS_PATH = '../../datasets/client_detect_clients.json'; // 検出入力: 依存メンバーシップ（state なし・事前用意＝make prepare-clients）
export const PATTERNS_PATH = `${PATTERNS_DIR}/patterns.json`;
export const GROUND_TRUTH_DIR = `${WORK_DIR}/ground-truth`; // 正解ラベル（版ペアごとのテスト結果）
export const ANALYSIS_DIR = `${DISCUSSION_DIR}/analysis`;   // 特徴量精査ツール（tool名ごと）
export const AUDIT_DIR = `${OUTPUT_BASE}/audit`;         // 実行監査ログ
export const GROUND_TRUTH_PATH = `${GROUND_TRUTH_DIR}/ground_truth.json`;
export const RECORDS_PATH = `${LIBRARY_DETECT_DIR}/records.json`; // runDetection の出力＝採点/分析の共通入力

// 一時的なサンプル調査の出力（本線 BC-LC と分離。latest 更新＋history にアーカイブ）
const SAMPLE_LATEST = '../../outputs/latest/BC-sample';
const SAMPLE_HISTORY = '../../outputs/history/BC-sample';

/** 正解1件（1つのバージョン遷移。state=クライアントテスト結果 / loss = state==='failure'） */
export interface GroundTruthPair {
  npm_pkg: string;
  prevVersion: string;
  updatedVersion: string;
  state: 'success' | 'failure';
  lossByClientTest: boolean;   // 正解: クライアントのテストが失敗したか（state==='failure'）。BC-LC の静的判定 bcLoss とは別物
}

/** 検出した損失候補1件（diffSurface の1タグ。採点は tag/detail/confidence のみ参照） */
export interface LossCandidate {
  tag: string;
  detail: string;
  confidence: string;
  symbol?: string;    // 対象の定義名（損失 API 一覧用。2026-10-09 以前の records には無い）
  filePath?: string;  // 定義ファイル（repo 相対）
}

/** 依存 range の pre→post 変化1件（間接依存起因の破壊を測るための signal。採点には不使用） */
export interface DepChange {
  name: string;                                    // 依存パッケージ名
  kind: 'dependencies' | 'peerDependencies';
  preRange?: string;                               // pre の range（added なら undefined）
  postRange?: string;                              // post の range（removed なら undefined）
  change: 'added' | 'removed' | 'major-bump' | 'minor-patch-bump';
}

// 1バージョンが評価不能な理由(atom)。runDetection が版ごとに付ける
export type ExcludeReason = 'no-repo-url' | 'clone-failed' | 'ref-unresolved' | 'build-error' | 'empty';

/**
 * 解析可否の3分類（混同行列でどう扱うかを決める唯一の基準。compare/scope はこれだけ見る）
 *   analyzed      両版とも export を抽出でき pre/post を diff できた → 通常評価（TP/FP/FN/TN）
 *   method-limit  コードは取れたが export が0件(empty) → 予測『損失なし』で FN/TN に計上（export を抽出できない）
 *   external      リポジトリ/版が取れず解析を試みられない → 母数から除外
 */
export type Analyzability = 'analyzed' | 'method-limit' | 'external';

// external＝解析を試みることすらできない atom（method-limit は empty のみ）
const EXTERNAL_REASONS: ReadonlySet<ExcludeReason> = new Set(['no-repo-url', 'clone-failed', 'ref-unresolved', 'build-error']);

/**
 * 1ペアの pre/post 側の評価不能理由(ok を除いた atom 群)から解析可否クラスを決める
 * 入力: 非ok な reason の配列 / 出力: Analyzability
 *   external を優先する（片版でもコードが取れなければ pre-post 比較そのものが成立しない）
 */
export function classifyAnalyzability(reasons: ExcludeReason[]): Analyzability {
  if (reasons.length === 0) return 'analyzed';
  if (reasons.some(r => EXTERNAL_REASONS.has(r))) return 'external';
  return 'method-limit'; // 残りは empty のみ
}

/**
 * 1ペアの検出事実（runDetection が全ペア分を records.json に書き、compare/analysis が読む）
 *   status='evaluated': 両バージョンの surface 抽出成功 → candidates が検出結果
 *   status='excluded' : どちらか評価不能（reason に理由）→ candidates は空
 *   analyzability      : 混同行列での扱いを決める型付きタグ（reason の文字列解釈に依存しないため）
 */
export interface DetectionRecord extends GroundTruthPair {
  status: 'evaluated' | 'excluded';
  reason: string;
  analyzability: Analyzability;
  bcLoss: BcLoss;             // 損失の判定。'loss'=損失候補あり / 'no-loss'=評価済みで候補なし / 'unevaluated'=評価不能(excluded)
  candidates: LossCandidate[];
  depChanges?: DepChange[];   // pre→post の依存 range 変化（signal・採点/FN判定には使わない）
}

/** DetectionRecord の損失有無ラベル（candidates は LOSS_TAGS のみ emit されるため「候補ありか」で決まる） */
export type BcLoss = 'loss' | 'no-loss' | 'unevaluated';

/**
 * 1ペアの生成パターン（runDetection が全ペア分を patterns.json に書く。client-detect の照合入力）
 *   patterns    : LOSS_TAGS の候補を R-BC 形式に変換したもの（0件＝損失候補なし or 全て skip）
 *   skippedTags : パターン化しなかった候補のタグ（converter が空を返した＝node-npm 等）
 */
export interface PatternRecord {
  npm_pkg: string;
  prevVersion: string;
  updatedVersion: string;
  patterns: GeneratedPattern[];
  skippedTags: string[];
}

/** records.json を読み込む。入力: なし / 出力: 検出事実の配列（無ければエラー終了） */
export function loadRecords(): DetectionRecord[] {
  const recordsPath = path.resolve(process.cwd(), RECORDS_PATH);
  if (!fs.existsSync(recordsPath)) {
    console.error(`[Error] ${recordsPath} が無い（先に evaluation/runDetection.ts）`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(recordsPath, 'utf-8')) as DetectionRecord[];
}

/** npm パッケージ名をディレクトリ名に使える形へ（@scope/name → _scope_name） */
export const toDirName = (packageName: string): string => packageName.replace(/[^a-zA-Z0-9_-]/g, '_');

/** dir 直下のサブディレクトリ名を返す（読めなければ空配列） */
function subDirs(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch { return []; }
}

/**
 * R-BC が評価したクライアント集合を "lib|owner/repo" の Set で返す（alldataset_clients 実体から）。
 *   R-BC は failure が要るため BC-LC の部分集合。評価のゾーン分け（shared / bclc-only）に使う。
 *   ディレクトリ構成: alldataset_clients/<lib>/<ver>/<state>/<owner>/<repo>。無ければ空 Set。
 */
export function loadRbcClientSet(): Set<string> {
  const base = path.resolve(process.cwd(), ALLDATASET_CLIENTS_BASE);
  const set = new Set<string>();
  if (!fs.existsSync(base)) return set;
  for (const lib of subDirs(base)) {
    const libDir = path.join(base, lib);
    for (const ver of subDirs(libDir)) {
      const verDir = path.join(libDir, ver);
      for (const state of subDirs(verDir)) {
        const stateDir = path.join(verDir, state);
        for (const owner of subDirs(stateDir)) {
          for (const repo of subDirs(path.join(stateDir, owner))) set.add(`${lib}|${owner}/${repo}`);
        }
      }
    }
  }
  return set;
}

/** CSV 1セルのエスケープ（, " 改行 を含む値は RFC4180 準拠でクオート） */
export const toCsvCell = (value: unknown): string => {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** ground_truth.json を読み込む。入力: なし / 出力: 正解ペア配列（無ければエラー終了） */
export function loadGroundTruth(): GroundTruthPair[] {
  const gtPath = path.resolve(process.cwd(), GROUND_TRUTH_PATH);
  if (!fs.existsSync(gtPath)) {
    console.error(`[Error] ${gtPath} が無い（先に evaluation/groundTruth.ts）`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(gtPath, 'utf-8')) as GroundTruthPair[];
}

/** 正解ペアを npm_pkg 単位でまとめる（同じ lib を1回だけ clone/解析するため）。入力: ペア配列 / 出力: lib名→ペア群 */
export function groupByLib(pairs: GroundTruthPair[]): Map<string, GroundTruthPair[]> {
  const byLib = new Map<string, GroundTruthPair[]>();
  for (const pair of pairs) {
    if (!byLib.has(pair.npm_pkg)) byLib.set(pair.npm_pkg, []);
    byLib.get(pair.npm_pkg)!.push(pair);
  }
  return byLib;
}

/** npm レジストリから packument(全メタ) を取得。repository URL と各バージョン gitHead の供給元。失敗時 null */
export async function fetchPackument(packageName: string): Promise<any | null> {
  try {
    const urlName = packageName.startsWith('@')
      ? '@' + encodeURIComponent(packageName.slice(1))
      : encodeURIComponent(packageName);
    const response = await fetch(`https://registry.npmjs.org/${urlName}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** 混同行列から precision/recall/accuracy/f1 を計算。入力: {tp,fp,fn,tn} / 出力: 小数3桁の指標 */
export function computeMetrics(m: { tp: number; fp: number; fn: number; tn: number }) {
  const total = m.tp + m.fp + m.fn + m.tn;
  const precision = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 0;
  const recall = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : 0;
  const accuracy = total > 0 ? (m.tp + m.tn) / total : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision: +precision.toFixed(3), recall: +recall.toFixed(3), accuracy: +accuracy.toFixed(3), f1: +f1.toFixed(3) };
}

/**
 * 指定バージョンへ checkout して API surface を抽出する（分析系スクリプト用の簡易版）
 * 入力: repoDir / version / gitHead(任意) / 出力: ApiSurface（解決不可・解析失敗・空は null）
 */
export async function buildSurfaceForVersion(repoDir: string, version: string, gitHead?: string | null): Promise<ApiSurfaceType | null> {
  const ref = LibRepo.resolveRef(repoDir, version, gitHead);
  if (!ref) return null;
  try {
    LibRepo.checkoutVersion(repoDir, ref);
    const surface = await ApiSurface.buildApiSurface(repoDir, version, ref);
    return surface; // 空 surface もそのまま返す（採点側で empty=抽出限界を「予測=損失なし」として fold。null は外部失敗のみ）
  } catch {
    return null;
  }
}

/** 空の ApiUsage を作る（絞り込みなしモードのプレースホルダ等） */
export const emptyUsage = (): ApiUsage => ({ named: new Set(), defaultUsed: false, deepPaths: new Set() });

/**
 * サンプル調査の結果を BC-sample に書く（本線 BC-LC と分離した一時調査置き場）
 *   latest/BC-sample/<experiment>/<fileName> を更新し history/BC-sample/<timestamp>/<experiment>/ にも複製
 *   入力: experiment(調査名) / fileName / data / 出力: 書いた latest 側パス
 */
export function writeSampleResult(experiment: string, fileName: string, data: unknown): string {
  const json = JSON.stringify(data, null, 2);
  const stamp = OutputJson.formatDateTime(new Date());
  const latestDir = path.resolve(process.cwd(), SAMPLE_LATEST, experiment);
  const historyDir = path.resolve(process.cwd(), SAMPLE_HISTORY, stamp, experiment);
  for (const dir of [latestDir, historyDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), json);
  }
  return path.join(latestDir, fileName);
}
