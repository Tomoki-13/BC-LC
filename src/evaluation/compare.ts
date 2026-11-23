import '../utils/loadEnv';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import {
  LOSS_JUDGEMENT_DIR, LOSS_BY_TAG_DIR, KEY_RESULTS_JSON, KEY_RESULTS_CSV, DetectionRecord, toCsvCell, loadRecords, computeMetrics,
} from '../utils/evalShared';

// 採点済み1ペア（各 CSV の1行。records の検出事実に正解ラベルを突き合わせた結果）
interface ScoredPair extends DetectionRecord {
  predictedLoss: boolean | null;  // evaluated のみ true/false
  lossCount: number;
  tags: string;                   // 検出タグ 重複排除（; 区切り）
  causes: string;                 // 損失の原因（tag:detail を | 区切り）
  category: '' | 'TP' | 'FP' | 'FN' | 'TN';
}

/**
 * 検出事実(loss_candidates_per_version_pair.json)を正解と突き合わせて category を付ける。入力: DetectionRecord / 出力: ScoredPair
 *   record.analyzability（runDetection が付けた型付きタグ）で扱いを分ける（reason 文字列は解釈しない）:
 *     external     → 混同行列の外（category=''）
 *     method-limit → 「予測=損失なし」で FN/TN に計上（コードは取れたが export が 0 件）
 *     ok           → 通常評価（candidates 有無で TP/FP/FN/TN）
 */
function scoreRecord(record: DetectionRecord): ScoredPair {
  if (record.analyzability === 'external') {
    return { ...record, predictedLoss: null, lossCount: 0, tags: '', causes: '', category: '' };
  }
  const predictedLoss = record.candidates.length > 0; // method-limit は candidates=[] → 予測『損失なし』
  const category: ScoredPair['category'] = record.lossByClientTest
    ? (predictedLoss ? 'TP' : 'FN')
    : (predictedLoss ? 'FP' : 'TN');
  const tags = [...new Set(record.candidates.map(c => c.tag))].join(';');
  const causes = record.analyzability === 'method-limit'
    ? `method-limit:${record.reason}` // export 0 件で空予測になった理由を残す
    : record.candidates.map(c => `${c.tag}:${c.detail}`).join(' | ');
  return { ...record, predictedLoss, lossCount: record.candidates.length, tags, causes, category };
}

/** loss_candidates_per_version_pair.json を採点し，混同行列・指標・各CSVを loss_judgement_accuracy/・loss_judgement_by_tag/ に出力する（clone/surface は行わない） */
export function runCompare(): void {
  const scored = loadRecords().map(scoreRecord);
  // 混同行列に入る = evaluated ＋ export 0 件(empty等)（category が付いたもの）／外部除外は category=''
  const evaluatedRows = scored.filter(row => row.category !== '');
  const excludedRows = scored.filter(row => row.category === '');

  const confusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const row of evaluatedRows) {
    if (row.category === 'TP') confusionMatrix.tp++;
    else if (row.category === 'FP') confusionMatrix.fp++;
    else if (row.category === 'FN') confusionMatrix.fn++;
    else confusionMatrix.tn++;
  }
  const metrics = computeMetrics(confusionMatrix);

  // 依存パッケージ由来の候補（dependency-breaking-change）を足したときの判定。依存パッケージを調べていない実行では null
  const dependencyAnalyzed = evaluatedRows.some(row => row.dependencyChecks !== undefined);
  const categoryWithDependency = (row: ScoredPair): ScoredPair['category'] => {
    const predicted = row.candidates.length + (row.dependencyCandidates?.length ?? 0) > 0;
    return row.lossByClientTest ? (predicted ? 'TP' : 'FN') : (predicted ? 'FP' : 'TN');
  };
  const withDependencyMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const changed = { fnToTp: [] as string[], tnToFp: [] as string[] };
  for (const row of evaluatedRows) {
    const c = categoryWithDependency(row);
    withDependencyMatrix[c.toLowerCase() as 'tp' | 'fp' | 'fn' | 'tn']++;
    const key = `${row.npm_pkg} ${row.prevVersion}→${row.updatedVersion}`;
    if (row.category === 'FN' && c === 'TP') changed.fnToTp.push(key);
    if (row.category === 'TN' && c === 'FP') changed.tnToFp.push(key);
  }
  const withDependency = dependencyAnalyzed ? {
    confusion: withDependencyMatrix,
    metrics: computeMetrics(withDependencyMatrix),
    fnToTp: changed.fnToTp,
    tnToFp: changed.tnToFp,
    versionPairsWithDependencyCandidates: evaluatedRows.filter(row => (row.dependencyCandidates?.length ?? 0) > 0).length,
  } : null;

  // 除外理由を集計（reason 中のバージョン番号カッコを外して同種をまとめる）
  const excludedByReason: Record<string, number> = {};
  for (const row of excludedRows) {
    const key = row.reason.replace(/\([^)]*\)/g, '');
    excludedByReason[key] = (excludedByReason[key] ?? 0) + 1;
  }

  const methodLimitRows = evaluatedRows.filter(row => row.analyzability === 'method-limit');
  const methodLimitFolded = methodLimitRows.length;
  const summary = {
    totalPairs: scored.length,
    matrixTotal: evaluatedRows.length,                          // 混同行列の件数（= evaluated + export 0 件）
    evaluatedNormal: evaluatedRows.length - methodLimitFolded,  // 両版の surface を抽出できたペア
    methodLimitFolded,                                          // export 0 件(empty)を予測『損失なし』として計上した数
    methodLimitBreakdown: {                                     // その内訳（FN=真の見逃し扱い / TN=正解扱い）
      fn: methodLimitRows.filter(r => r.category === 'FN').length,
      tn: methodLimitRows.filter(r => r.category === 'TN').length,
    },
    externalExcluded: excludedRows.length,                      // リポジトリ無し/clone失敗/版未解決（混同行列の外）
    excludedByReason,
    groundTruth: {
      failure_loss: evaluatedRows.filter(row => row.lossByClientTest).length,
      success_noLoss: evaluatedRows.filter(row => !row.lossByClientTest).length,
    },
    confusion: confusionMatrix,                                  // 依存パッケージ由来の候補を入れない値（以前の実行と比べられる値）
    metrics,
    withDependency,                                              // 依存パッケージ由来の候補（dependency-breaking-change）を足した値
  };

  // 混同行列・バージョンペアごとの判定・除外は loss_judgement_accuracy/、タグ別 TP/FP は loss_judgement_by_tag/
  const outputDir = path.resolve(process.cwd(), LOSS_JUDGEMENT_DIR);
  const byTagDir = path.resolve(process.cwd(), LOSS_BY_TAG_DIR);
  OutputJson.createOutputDirectory(outputDir);
  OutputJson.createOutputDirectory(byTagDir);
  fs.writeFileSync(path.join(outputDir, KEY_RESULTS_JSON), JSON.stringify(summary, null, 2));

  // 評価用 CSV（評価できたペア: test_result / 判定した損失の有無 / 原因）
  const evaluationHeader = 'npm_pkg,prevVersion,updatedVersion,test_result,predicted_loss,category,loss_count,tags,causes,dependency_loss_count,category_with_dependency,dependency_causes\n';
  fs.writeFileSync(path.join(outputDir, 'detail_evaluated_version_pairs.csv'), evaluationHeader + evaluatedRows.map(row =>
    [row.npm_pkg, row.prevVersion, row.updatedVersion, row.state, row.predictedLoss ? 'yes' : 'no', row.category, row.lossCount, row.tags, row.causes,
      row.dependencyCandidates?.length ?? '', dependencyAnalyzed ? categoryWithDependency(row) : '',
      (row.dependencyCandidates ?? []).map(c => `${c.symbol}: ${c.detail}`).join(' | ')].map(toCsvCell).join(','),
  ).join('\n'));

  // 除外 CSV（評価できなかったペアと理由）
  const excludedHeader = 'npm_pkg,prevVersion,updatedVersion,test_result,reason\n';
  fs.writeFileSync(path.join(outputDir, 'detail_excluded_version_pairs.csv'), excludedHeader + excludedRows.map(row =>
    [row.npm_pkg, row.prevVersion, row.updatedVersion, row.state, row.reason].map(toCsvCell).join(','),
  ).join('\n'));

  // 損失タグ(=Positive と判定した理由)の分布。ペア単位・タグ重複排除（1ペアで同タグ複数でも1）
  const tagStats: Record<string, { tp: number; fp: number }> = {};
  for (const row of evaluatedRows) {
    if (row.category !== 'TP' && row.category !== 'FP') continue;
    for (const tag of row.tags.split(';').filter(Boolean)) {
      (tagStats[tag] ??= { tp: 0, fp: 0 })[row.category === 'TP' ? 'tp' : 'fp']++;
    }
  }
  // 依存パッケージ由来の候補は，それを足したときの判定（TP/FP）で数える
  for (const row of evaluatedRows) {
    if (!row.dependencyCandidates?.length) continue;
    const c = categoryWithDependency(row);
    if (c !== 'TP' && c !== 'FP') continue;
    (tagStats['dependency-breaking-change'] ??= { tp: 0, fp: 0 })[c === 'TP' ? 'tp' : 'fp']++;
  }
  const distributionRows = Object.entries(tagStats)
    .map(([tag, s]) => ({ tag, tp: s.tp, fp: s.fp, total: s.tp + s.fp, precision: +(s.tp / (s.tp + s.fp)).toFixed(3) }))
    .sort((a, b) => b.total - a.total);
  fs.writeFileSync(path.join(byTagDir, KEY_RESULTS_CSV), 'tag,TP,FP,total,precision\n' +
    distributionRows.map(d => [d.tag, d.tp, d.fp, d.total, d.precision].join(',')).join('\n'));

  // 素の判定（後方互換）
  const detailHeader = 'npm_pkg,prevVersion,updatedVersion,lossByClientTest,predictedLoss,lossCount,status,reason\n';
  fs.writeFileSync(path.join(outputDir, 'detail_judgement_per_version_pair.csv'), detailHeader + scored.map(row =>
    [row.npm_pkg, row.prevVersion, row.updatedVersion, row.lossByClientTest, row.predictedLoss, row.lossCount, row.status, row.reason].map(toCsvCell).join(','),
  ).join('\n'));

  console.log(JSON.stringify(summary, null, 2));
  console.log(`[Done] loss-judgement=${outputDir}・by-tag=${byTagDir}`);
}

// CLI 直接実行時のみ走らせる（import 時は走らせない）
if (process.argv[1] && /compare\.(ts|js)$/.test(process.argv[1])) {
  runCompare();
}
