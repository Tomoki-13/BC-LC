import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import {
  EVAL_DIR, DetectionRecord, toCsvCell, loadRecords, computeMetrics,
} from '../utils/evalShared';

// 採点済み1ペア（各 CSV の1行。records の検出事実に正解ラベルを突き合わせた結果）
interface ScoredPair extends DetectionRecord {
  predictedLoss: boolean | null;  // evaluated のみ true/false
  lossCount: number;
  tags: string;                   // 検出タグ 重複排除（; 区切り）
  causes: string;                 // 損失の原因（tag:detail を | 区切り）
  category: '' | 'TP' | 'FP' | 'FN' | 'TN';
}

/** 検出事実(records.json)を正解と突き合わせて category を付ける。入力: DetectionRecord / 出力: ScoredPair */
function scoreRecord(record: DetectionRecord): ScoredPair {
  if (record.status === 'excluded') {
    return { ...record, predictedLoss: null, lossCount: 0, tags: '', causes: '', category: '' };
  }
  const predictedLoss = record.candidates.length > 0;
  const category: ScoredPair['category'] = record.loss
    ? (predictedLoss ? 'TP' : 'FN')
    : (predictedLoss ? 'FP' : 'TN');
  const tags = [...new Set(record.candidates.map(c => c.tag))].join(';');
  const causes = record.candidates.map(c => `${c.tag}:${c.detail}`).join(' | ');
  return { ...record, predictedLoss, lossCount: record.candidates.length, tags, causes, category };
}

/** records.json を採点し，混同行列・指標・各CSVを eval/ に出力する（clone/surface は行わない） */
export function runCompare(): void {
  const scored = loadRecords().map(scoreRecord);
  const evaluatedRows = scored.filter(row => row.status === 'evaluated');
  const excludedRows = scored.filter(row => row.status === 'excluded');

  const confusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const row of evaluatedRows) {
    if (row.category === 'TP') confusionMatrix.tp++;
    else if (row.category === 'FP') confusionMatrix.fp++;
    else if (row.category === 'FN') confusionMatrix.fn++;
    else confusionMatrix.tn++;
  }
  const metrics = computeMetrics(confusionMatrix);

  // 除外理由を集計（reason 中のバージョン番号カッコを外して同種をまとめる）
  const excludedByReason: Record<string, number> = {};
  for (const row of excludedRows) {
    const key = row.reason.replace(/\([^)]*\)/g, '');
    excludedByReason[key] = (excludedByReason[key] ?? 0) + 1;
  }

  const summary = {
    totalPairs: scored.length,
    evaluated: evaluatedRows.length,
    excluded: excludedRows.length,
    excludedByReason,
    groundTruth: {
      failure_loss: evaluatedRows.filter(row => row.loss).length,
      success_noLoss: evaluatedRows.filter(row => !row.loss).length,
    },
    confusion: confusionMatrix,
    metrics,
  };

  const outputDir = path.resolve(process.cwd(), EVAL_DIR);
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
  fs.writeFileSync(path.join(outputDir, 'compare_detail.csv'), detailHeader + scored.map(row =>
    [row.npm_pkg, row.prevVersion, row.updatedVersion, row.loss, row.predictedLoss, row.lossCount, row.status, row.reason].map(toCsvCell).join(',')
  ).join('\n'));

  console.log(JSON.stringify(summary, null, 2));
  console.log(`[Done] eval=${outputDir}`);
}

// CLI 直接実行時のみ走らせる（import 時は走らせない）
if (process.argv[1] && /compare\.(ts|js)$/.test(process.argv[1])) {
  runCompare();
}
