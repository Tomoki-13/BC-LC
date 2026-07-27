import fs from 'fs';
import path from 'path';

import { ANALYSIS_DIR, loadRecords } from '../utils/evalShared';

// タグ or confidence → {fail=正解損失あり, succ=正解損失なし} のカウンタ
type Tally = Record<string, { fail: number; succ: number }>;

/** Tally の該当キーを loss に応じて加算する */
function bump(tally: Tally, key: string, loss: boolean): void {
  if (!tally[key]) tally[key] = { fail: 0, succ: 0 };
  if (loss) tally[key].fail++;
  else tally[key].succ++;
}

/** Tally を {key,fail,succ,total,failRate} の配列に整形（succ 降順＝FP寄与が多い順） */
const formatTally = (tally: Tally) => Object.entries(tally)
  .map(([key, v]) => ({ key, fail: v.fail, succ: v.succ, total: v.fail + v.succ, failRate: +(v.fail / (v.fail + v.succ)).toFixed(3) }))
  .sort((a, b) => b.succ - a.succ);

/** 検出タグ別に fail/succ を集計し、FP のノイズ源を特定する（records.json 由来 → tag_analysis.json） */
function runTagAnalysis(): void {
  const records = loadRecords().filter(r => r.status === 'evaluated');

  const byTag: Tally = {};        // タグが1件でも出たペア数
  const byConfidence: Tally = {}; // confidence が出たペア数
  const soleTag: Tally = {};      // そのタグ「だけ」が出た（唯一の検出理由）ペア数
  let predictedLossPairs = 0;

  for (const record of records) {
    if (record.candidates.length === 0) continue;
    predictedLossPairs++;
    const tags = new Set(record.candidates.map(c => c.tag));
    const confidences = new Set(record.candidates.map(c => c.confidence));
    for (const tag of tags) bump(byTag, tag, record.loss);
    for (const confidence of confidences) bump(byConfidence, confidence, record.loss);
    if (tags.size === 1) bump(soleTag, [...tags][0], record.loss);
  }

  const summary = {
    analyzablePairs: records.length,
    predictedLossPairs,
    note: 'succ=そのタグが出た success(no-loss)ペア数=FP寄与。failRate 低いほどノイズ',
    byTag: formatTally(byTag),
    byConfidence: formatTally(byConfidence),
    soleReasonTag: formatTally(soleTag),
  };

  const outputDir = path.resolve(process.cwd(), ANALYSIS_DIR, 'tagAnalysis');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'tag_analysis.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[Done] ${outputDir}/tag_analysis.json`);
}

if (process.argv[1] && /tagAnalysis\.(ts|js)$/.test(process.argv[1])) {
  runTagAnalysis();
}

export { runTagAnalysis };
