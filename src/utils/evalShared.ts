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
//   結果は「何の結果か」ごとのフォルダに分け、各フォルダの一番大事な数値は key_results.<json|csv> に置く（1フォルダに1つ）
//   breakdown_*＝内訳（タグ別・ライブラリ別・群別）／detail_*＝1行1件の明細。構成と列は docs/mechanics/output-reference.md
export const LATEST_BCLC_BASE = '../../outputs/latest/BC-LC';
export const RUN_LATEST_BASE = `${LATEST_BCLC_BASE}/${RUN_VARIANT}`;
// make run（BCLC_WRITE_TO=history）は実行中 history/BC-LC/<RUN_ID>_<モード>/ に書き、最後に latest/BC-LC/ を空にして写す（index.ts の publishToLatest）
//   それ以外（make detect・compare・scope など段だけの実行）は latest/BC-LC/<モード>/ を読み書きする
export const RUN_HISTORY_BASE = `../../outputs/history/BC-LC/${process.env.BCPG_RUN_ID ?? 'no-run-id'}_${RUN_VARIANT}`;
export const RUN_OUTPUT_BASE = process.env.BCLC_WRITE_TO === 'history' && process.env.BCPG_RUN_ID ? RUN_HISTORY_BASE : RUN_LATEST_BASE;
const OUTPUT_BASE = RUN_OUTPUT_BASE;
export const KEY_RESULTS_JSON = 'key_results.json';
export const KEY_RESULTS_CSV = 'key_results.csv';
export const RUN_SUMMARY_DIR = `${OUTPUT_BASE}/run_summary`;                               // 実行全体の一番大事な数値・バージョンペアごとのまとめ
export const LOSS_JUDGEMENT_DIR = `${OUTPUT_BASE}/loss_judgement_accuracy`;                // 損失判定の精度（混同行列・バージョンペアごとの判定・除外）
export const LOSS_BY_TAG_DIR = `${OUTPUT_BASE}/loss_judgement_by_tag`;                     // 損失判定のタグごとの TP/FP
export const SCOPE_COMPARE_DIR = `${OUTPUT_BASE}/loss_judgement_by_api_scope`;             // API の範囲ごとの損失判定の比較
export const RETURN_ANALYSIS_DIR = `${OUTPUT_BASE}/return_changed_analysis`;               // return-changed の候補の分析
export const EXTRACTION_COVERAGE_DIR = `${OUTPUT_BASE}/extracted_functions_vs_dts`;        // .d.ts と比べた surface 抽出の網羅率
export const LOSS_FUNCTIONS_DIR = `${OUTPUT_BASE}/loss_functions_list`;                    // 損失と判定した関数（＝パターン化した関数）の一覧
export const PUBLIC_API_INVENTORY_DIR = `${OUTPUT_BASE}/public_api_inventory`;             // 公開 API の一覧と .d.ts・DIAGNOSE の突き合わせ（make api-inventory）
export const PATTERNS_DIR = `${OUTPUT_BASE}/generated_patterns`;                           // 損失候補 → R-BC 形式の検出パターン（client-detect の照合入力）
export const CLIENT_DETECT_DIR = `${OUTPUT_BASE}/detected_clients`;                        // 検出したクライアント（群ごとの集計・明細・照合の詳細）
export const INTERMEDIATE_DIR = `${OUTPUT_BASE}/intermediate_data`;                        // 次の段の入力になる途中データ
export const LIBRARY_DETECT_DIR = `${INTERMEDIATE_DIR}/loss_candidates`;                   // バージョンペアごとの損失候補（runDetection の出力）
export const SURFACE_DIR = `${INTERMEDIATE_DIR}/api_surface`;                              // 損失判定に使った pre/post の API surface（<lib>/<upd>/{pre,post,diff}.json）
export const CHANGEVER_DIR = `${OUTPUT_BASE}/changeversion_input`;                         // changeversion（ClientFixTrace）の入力と同じ形（R-BC の method/<lib>_<verKey>/ と同じ並び）
/** detected_clients/ の中の群ごとのフォルダ（<群>/ にバージョンペアごとの照合の詳細と群の内訳） */
export const groupDirOf = (clientDetectBase: string, group: string) => `${clientDetectBase}/per_group/${group}`;
// 検出だけの実行（make client-detect）の出力。latest は latest/BC-LC/detect_only_<パターンの出所>_detect-<粒度>/（同じ名前のフォルダだけ消して書き直す）・history に日時スナップショット
export const DETECT_STANDALONE_HISTORY = '../../outputs/history/BC-LC-detect';
export const DEPENDENCY_CLONE_BASE = '../../clonedata/dependency_versions'; // 依存パッケージのクローン（<パッケージ>/．make clone-dependencies が作る．分析対象の lib_versions とは分ける）
// 依存パッケージの調査をするか（make run の DEPENDENCY=0 で飛ばす）
export const DEPENDENCY_ENABLED = process.env.BCLC_DEPENDENCY !== '0';
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
export const PATTERNS_PATH = `${PATTERNS_DIR}/all_patterns.json`;
export const GROUND_TRUTH_DIR = `${INTERMEDIATE_DIR}/ground_truth`; // 正解ラベル（版ペアごとのテスト結果）
export const ANALYSIS_DIR = `${OUTPUT_BASE}/other_analysis`;   // make run に含まれない分析ツール（ツール名ごと）
export const AUDIT_DIR = `${OUTPUT_BASE}/audit`;         // 実行監査ログ
export const GROUND_TRUTH_PATH = `${GROUND_TRUTH_DIR}/ground_truth.json`;
export const RECORDS_PATH = `${LIBRARY_DETECT_DIR}/loss_candidates_per_version_pair.json`; // runDetection の出力＝採点/分析の共通入力

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

/** 依存 range の pre→post 変化1件（採点には使わない） */
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
 * 1ペアの検出事実（runDetection が全ペア分を loss_candidates_per_version_pair.json に書き、compare/analysis が読む）
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
  depChanges?: DepChange[];   // pre→post の依存 range 変化（採点には使わない）
  dependencyCandidates?: LossCandidate[]; // 依存パッケージの破壊的変更が及ぶ公開関数（dependency-breaking-change）。依存パッケージを調べたときだけ（DEPENDENCY_ENABLED）
  dependencyChecks?: unknown[];           // 依存パッケージごとの調べた結果（dependencyLoss/dependencyBreakingChange.ts の DependencyCheck）
}

/** DetectionRecord の損失有無ラベル（candidates は LOSS_TAGS のみ emit されるため「候補ありか」で決まる） */
export type BcLoss = 'loss' | 'no-loss' | 'unevaluated';

/**
 * 1ペアの生成パターン（runDetection が全ペア分を all_patterns.json に書く。client-detect の照合入力）
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

/** loss_candidates_per_version_pair.json を読み込む。入力: なし / 出力: 検出事実の配列（無ければエラー終了） */
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
    return surface; // 空 surface もそのまま返す（採点側で empty を「予測=損失なし」として数える。null は外部失敗のみ）
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
