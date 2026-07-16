import fs from 'fs';
import path from 'path';
import OutputJson from './output_json';
import ApiSurface from '../libDiff/apiSurface';
import LibRepo from '../libDiff/libRepo';
import type { ApiSurface as ApiSurfaceType, ApiUsage } from '../types/LibDiff';

// eval 系スクリプトが共有する入出力パス（process.cwd() = BC-LC/src 基準）
export const CLONE_BASE = '../../clonedata/lib_versions';
const OUTPUT_BASE = '../../outputs/latest/BC-LC';
export const DETECTION_DIR = `${OUTPUT_BASE}/detection`; // 損失有無の事実（検出の生データ）
export const EVAL_DIR = `${OUTPUT_BASE}/eval`;           // 採点結果（混同行列・指標）
export const ANALYSIS_DIR = `${OUTPUT_BASE}/analysis`;   // 特徴量精査ツール（tool名ごと）
export const AUDIT_DIR = `${OUTPUT_BASE}/audit`;         // 実行監査ログ
export const GROUND_TRUTH_PATH = `${EVAL_DIR}/ground_truth.json`;
export const RECORDS_PATH = `${DETECTION_DIR}/records.json`; // runDetection の出力＝採点/分析の共通入力

// 一時的なサンプル調査の出力（本線 BC-LC と分離。latest 更新＋history にアーカイブ）
const SAMPLE_LATEST = '../../outputs/latest/BC-sample';
const SAMPLE_HISTORY = '../../outputs/history/BC-sample';

/** 正解1件（1つのバージョン遷移。state=クライアントテスト結果 / loss = state==='failure'） */
export interface GroundTruthPair {
  npm_pkg: string;
  prevVersion: string;
  updatedVersion: string;
  state: 'success' | 'failure';
  loss: boolean;
}

/** 検出した損失候補1件（diffSurface の1タグ。採点/分析はこの3項目のみ参照） */
export interface LossCandidate {
  tag: string;
  detail: string;
  confidence: string;
}

/** 依存 range の pre→post 変化1件（間接依存起因の破壊を測るための signal。採点には不使用） */
export interface DepChange {
  name: string;                                    // 依存パッケージ名
  kind: 'dependencies' | 'peerDependencies';
  preRange?: string;                               // pre の range（added なら undefined）
  postRange?: string;                              // post の range（removed なら undefined）
  change: 'added' | 'removed' | 'major-bump' | 'minor-patch-bump';
}

/**
 * 1ペアの検出事実（runDetection が全ペア分を records.json に書き、compare/analysis が読む）
 *   status='evaluated': 両バージョンの surface 抽出成功 → candidates が検出結果
 *   status='excluded' : どちらか評価不能（reason に理由）→ candidates は空
 */
export interface DetectionRecord extends GroundTruthPair {
  status: 'evaluated' | 'excluded';
  reason: string;
  candidates: LossCandidate[];
  depChanges?: DepChange[];   // pre→post の依存 range 変化（signal・採点/FN判定には使わない）
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

/** CSV 1セルのエスケープ（, " 改行 を含む値は RFC4180 準拠でクオート） */
export const toCsvCell = (value: unknown): string => {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** ground_truth.json を読み込む。入力: なし / 出力: 正解ペア配列（無ければエラー終了） */
export function loadGroundTruth(): GroundTruthPair[] {
  const gtPath = path.resolve(process.cwd(), GROUND_TRUTH_PATH);
  if (!fs.existsSync(gtPath)) {
    console.error(`[Error] ${gtPath} が無い（先に eval/groundTruth.ts）`);
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
    return surface.symbols.length > 0 ? surface : null; // 空 surface は評価対象外
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
