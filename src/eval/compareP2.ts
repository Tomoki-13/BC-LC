import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import ApiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import LibRepo from '../libDiff/libRepo';
import RunLogger from '../utils/runLogger';
import { extractRepositoryUrl } from '../collectDataset/npm/registry';

// ground_truth(正解) と P2(libDiff) の損失判定を比較し混同行列を出す
// 出力:
//   compare_summary.json … 評価できたペアの混同行列＋除外内訳
//   evaluation.csv        … 評価できたペア（test_result / 損失有無 / 原因）
//   excluded_pairs.csv    … 評価できなかったペアと理由
//   label_distribution.csv… 損失タグ別の TP/FP 分布
//   compare_detail.csv    … 全ペアの素の判定（後方互換）
//   compareP2_run*.{log,json} … 監査（バージョン解決手段・警告・エラー）

const GROUND_TRUTH_PATH = '../../outputs/latest/BC-LC/eval/ground_truth.json';
const CLONE_BASE = '../../clonedata/lib_versions';
const OUTPUT_DIR = '../../outputs/latest/BC-LC/eval';

// npm パッケージ名をディレクトリ名に使える形へ（@scope/name → _scope_name）
const toDirName = (packageName: string) => packageName.replace(/[^a-zA-Z0-9_-]/g, '_');
// CSV 1セルのエスケープ（, " 改行 を含む値は RFC4180 準拠でクオート）
const toCsvCell = (value: unknown) => {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// 正解1件（1つのバージョン遷移。state=クライアントテスト結果 / loss = state==='failure'）
interface GroundTruthPair {
  npm_pkg: string;
  prevVersion: string;
  updatedVersion: string;
  state: 'success' | 'failure';
  loss: boolean;
}

// 1バージョンの surface 取得結果（reason で「なぜ評価不能か」を表す）
interface SurfaceResult {
  surface: any | null;
  reason: 'ok' | 'ref-unresolved' | 'build-error' | 'empty';
}

// 1ペアの評価結果（各 CSV の1行になる）
interface PairResult extends GroundTruthPair {
  status: 'evaluated' | 'excluded';
  reason: string;                 // excluded の理由 / evaluated は 'ok'
  predictedLoss: boolean | null;  // evaluated のみ true/false
  lossCount: number;
  tags: string;                   // 検出タグ 重複排除（; 区切り）
  causes: string;                 // 損失の原因（tag:detail を | 区切り）
  category: '' | 'TP' | 'FP' | 'FN' | 'TN';
}

/** npm レジストリから packument(全メタ) を取得。repository URL と各バージョン gitHead の供給元。失敗時 null */
async function fetchPackument(packageName: string): Promise<any | null> {
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

/** ground_truth 全ペアに P2 を実行し，混同行列と各CSV/監査を出力（maxLibs=先頭N libのパイロット用） */
export async function runCompareP2(maxLibs: number = Infinity): Promise<void> {
  const logger = new RunLogger(); // バージョン解決手段・警告・エラーを監査ファイルに残す

  const groundTruthPath = path.resolve(process.cwd(), GROUND_TRUTH_PATH);
  if (!fs.existsSync(groundTruthPath)) {
    console.error(`[Error] ${groundTruthPath} が無い（先に eval/groundTruth.ts）`);
    process.exit(1);
  }
  const groundTruthPairs = JSON.parse(fs.readFileSync(groundTruthPath, 'utf-8')) as GroundTruthPair[];

  // ライブラリ単位でペアをまとめる（同じ lib は1回だけ clone し surface を共有するため）
  const pairsByLib = new Map<string, GroundTruthPair[]>();
  for (const pair of groundTruthPairs) {
    if (!pairsByLib.has(pair.npm_pkg)) pairsByLib.set(pair.npm_pkg, []);
    pairsByLib.get(pair.npm_pkg)!.push(pair);
  }
  const libNames = [...pairsByLib.keys()].slice(0, maxLibs);
  console.log(`[compareP2] libs=${libNames.length} (全${pairsByLib.size}), pairs=${libNames.reduce((n, l) => n + pairsByLib.get(l)!.length, 0)}`);

  const resultRows: PairResult[] = []; // 全ペアの評価/除外結果を蓄積
  // GroundTruthPair に空メタを足した PairResult の土台
  const baseRow = (pair: GroundTruthPair): Omit<PairResult, 'status' | 'reason' | 'predictedLoss' | 'category'> =>
    ({ ...pair, lossCount: 0, tags: '', causes: '' });
  // 除外行（評価できなかったペア）を作る
  const excludedRow = (pair: GroundTruthPair, reason: string): PairResult =>
    ({ ...baseRow(pair), status: 'excluded', reason, predictedLoss: null, category: '' });

  let libIndex = 0;
  for (const libName of libNames) {
    libIndex++;
    const libPairs = pairsByLib.get(libName)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, toDirName(libName));
    process.stderr.write(`\r[${libIndex}/${libNames.length}] ${libName} (${libPairs.length} pairs)            `);

    const packument = await fetchPackument(libName);
    if (!packument) logger.warn(libName, '-', 'registry', 'npm registry doc 取得失敗（gitHead フォールバック不可）');

    // クローン準備（未クローンなら repository URL を得て clone）
    if (!fs.existsSync(repoDir)) {
      const repoUrl = packument ? extractRepositoryUrl(packument?.versions?.[libPairs[0].updatedVersion] ?? packument) : null;
      if (!repoUrl) {
        logger.error(libName, '-', 'clone', 'repository URL を特定できず（no-repo-url）');
        for (const pair of libPairs) resultRows.push(excludedRow(pair, 'no-repo-url'));
        continue;
      }
      try {
        LibRepo.ensureClone(repoUrl, repoDir, process.env.GITHUB_TOKEN);
      } catch (e: any) {
        logger.error(libName, '-', 'clone', `clone 失敗: ${e?.message ?? e}`);
        for (const pair of libPairs) resultRows.push(excludedRow(pair, 'clone-failed'));
        continue;
      }
    }

    // バージョン文字列 → surface を1回だけ抽出してキャッシュ（reason 付き）。
    // repoDir / packument / surfaceCache をクロージャで捕捉するためローカルのアロー関数にしている
    const surfaceCache = new Map<string, SurfaceResult>();
    const getSurface = async (version: string): Promise<SurfaceResult> => {
      // 一度解析している場合は使いまわす
      const cached = surfaceCache.get(version);
      if (cached) return cached;

      // どの commit に checkout するか（tag→package.json→gitHead→commit-message の順）を解決
      const { ref: commitRef, method: commitResolveMethod } = LibRepo.resolveRefDetailed(repoDir, version, packument?.versions?.[version]?.gitHead);
      logger.resolution(libName, version, commitResolveMethod, commitRef);

      let result: SurfaceResult;
      if (!commitRef) {
        logger.error(libName, version, 'resolve', 'tag/package.json/gitHead/commit-message いずれでも checkout 先 commit を特定できず');
        result = { surface: null, reason: 'ref-unresolved' };
      } else {
        if (commitResolveMethod === 'git-head' || commitResolveMethod === 'commit-message') {
          logger.warn(libName, version, 'resolve', `低信頼な手段で解決(${commitResolveMethod}) ref=${commitRef.slice(0, 12)}（要目視確認）`);
        }
        try {
          // メイン処理
          LibRepo.checkoutVersion(repoDir, commitRef);
          const surface = await ApiSurface.buildApiSurface(repoDir, version, commitRef);
          if (surface.symbols.length === 0) {
            logger.warn(libName, version, 'surface', `export 関数が0件（抽出漏れ/ビルド成果物未コミット等）ref=${commitRef.slice(0, 12)}`);
            result = { surface, reason: 'empty' };
          } else {
            result = { surface, reason: 'ok' };
          }
        } catch (e: any) {
          logger.error(libName, version, 'surface', `checkout/解析 失敗: ${e?.message ?? e}`);
          result = { surface: null, reason: 'build-error' };
        }
      }
      surfaceCache.set(version, result);
      return result;
    };

    for (const pair of libPairs) {
      const preSurface = await getSurface(pair.prevVersion);
      const postSurface = await getSurface(pair.updatedVersion);

      // どちらかのバージョンが評価不能なら除外（どのバージョンが何の理由かを記録）
      if (preSurface.reason !== 'ok' || postSurface.reason !== 'ok') {
        const reasonParts: string[] = [];
        if (preSurface.reason !== 'ok') reasonParts.push(`pre(${pair.prevVersion}):${preSurface.reason}`);
        if (postSurface.reason !== 'ok') reasonParts.push(`post(${pair.updatedVersion}):${postSurface.reason}`);
        resultRows.push(excludedRow(pair, reasonParts.join(' / ')));
        continue;
      }

      const lossCandidates = DiffSurface.diffSurface(preSurface.surface, postSurface.surface, libName);
      const predictedLoss = lossCandidates.length > 0;
      const category: PairResult['category'] = pair.loss
        ? (predictedLoss ? 'TP' : 'FN')
        : (predictedLoss ? 'FP' : 'TN');
      const tags = [...new Set(lossCandidates.map((c: any) => c.tag))].join(';');
      const causes = lossCandidates.map((c: any) => `${c.tag}:${c.detail ?? c.label}`).join(' | ');
      resultRows.push({ ...baseRow(pair), status: 'evaluated', reason: 'ok', predictedLoss, lossCount: lossCandidates.length, tags, causes, category });
    }
  }
  process.stderr.write('\n');

  // 集計（評価できたペアのみで混同行列）
  const evaluatedRows = resultRows.filter(row => row.status === 'evaluated');
  const excludedRows = resultRows.filter(row => row.status === 'excluded');

  const confusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const row of evaluatedRows) {
    if (row.category === 'TP') confusionMatrix.tp++;
    else if (row.category === 'FP') confusionMatrix.fp++;
    else if (row.category === 'FN') confusionMatrix.fn++;
    else confusionMatrix.tn++;
  }

  const { tp, fp, fn, tn } = confusionMatrix;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const accuracy = evaluatedRows.length > 0 ? (tp + tn) / evaluatedRows.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // 除外理由を集計（reason 中のバージョン番号カッコを外して同種をまとめる）
  const excludedByReason: Record<string, number> = {};
  for (const row of excludedRows) {
    const key = row.reason.replace(/\([^)]*\)/g, '');
    excludedByReason[key] = (excludedByReason[key] ?? 0) + 1;
  }

  const summary = {
    totalPairs: resultRows.length,
    evaluated: evaluatedRows.length,
    excluded: excludedRows.length,
    excludedByReason,
    groundTruth: {
      failure_loss: evaluatedRows.filter(row => row.loss).length,
      success_noLoss: evaluatedRows.filter(row => !row.loss).length,
    },
    confusion: confusionMatrix,
    metrics: {
      precision: +precision.toFixed(4),
      recall: +recall.toFixed(4),
      accuracy: +accuracy.toFixed(4),
      f1: +f1.toFixed(4),
    },
  };

  const outputDir = path.resolve(process.cwd(), OUTPUT_DIR);
  OutputJson.createOutputDirectory(outputDir);
  fs.writeFileSync(path.join(outputDir, 'compare_summary.json'), JSON.stringify(summary, null, 2));

  // 評価用 CSV（評価できたペア: test_result / 本手法の損失有無 / 原因）
  const evaluationHeader = 'npm_pkg,prevVersion,updatedVersion,test_result,predicted_loss,category,loss_count,tags,causes\n';
  fs.writeFileSync(path.join(outputDir, 'evaluation.csv'), evaluationHeader + evaluatedRows.map(row =>
    [row.npm_pkg, row.prevVersion, row.updatedVersion, row.state, row.predictedLoss ? 'yes' : 'no', row.category, row.lossCount, row.tags, row.causes].map(toCsvCell).join(',')
  ).join('\n'));

  // 除外 CSV（評価できなかったペアと理由）
  const excludedHeader = 'npm_pkg,prevVersion,updatedVersion,test_result,reason\n';
  fs.writeFileSync(path.join(outputDir, 'excluded_pairs.csv'), excludedHeader + excludedRows.map(row =>
    [row.npm_pkg, row.prevVersion, row.updatedVersion, row.state, row.reason].map(toCsvCell).join(',')
  ).join('\n'));

  // 損失タグ(=Positive と判定した理由)の分布。ペア単位・タグ重複排除（1ペアで同タグ複数でも1）
  const tagStats: Record<string, { tp: number; fp: number }> = {};
  for (const row of evaluatedRows) {
    if (row.category !== 'TP' && row.category !== 'FP') continue;
    for (const tag of row.tags.split(';').filter(Boolean)) {
      (tagStats[tag] ??= { tp: 0, fp: 0 })[row.category === 'TP' ? 'tp' : 'fp']++;
    }
  }
  const distributionRows = Object.entries(tagStats)
    .map(([tag, s]) => ({ tag, tp: s.tp, fp: s.fp, total: s.tp + s.fp, precision: +(s.tp / (s.tp + s.fp)).toFixed(3) }))
    .sort((a, b) => b.total - a.total);
  fs.writeFileSync(path.join(outputDir, 'label_distribution.csv'), 'tag,TP,FP,total,precision\n' +
    distributionRows.map(d => [d.tag, d.tp, d.fp, d.total, d.precision].join(',')).join('\n'));

  // 素の判定（後方互換）
  const detailHeader = 'npm_pkg,prevVersion,updatedVersion,groundTruthLoss,predictedLoss,lossCount,status,reason\n';
  fs.writeFileSync(path.join(outputDir, 'compare_detail.csv'), detailHeader + resultRows.map(row =>
    [row.npm_pkg, row.prevVersion, row.updatedVersion, row.loss, row.predictedLoss, row.lossCount, row.status, row.reason].map(toCsvCell).join(',')
  ).join('\n'));

  logger.flush(outputDir, 'compareP2');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[Done] ${outputDir}/{compare_summary.json, evaluation.csv, excluded_pairs.csv, label_distribution.csv, compare_detail.csv}`);
}

// CLI 直接実行時のみ走らせる（import 時は走らせない）
if (process.argv[1] && /compareP2\.(ts|js)$/.test(process.argv[1])) {
  const maxLibs = process.argv[2] ? Number(process.argv[2]) : Infinity;
  runCompareP2(maxLibs).catch(e => { console.error('[Fatal]', e); process.exit(1); });
}
