import fs from 'fs';
import path from 'path';

import { ANALYSIS_DIR, loadRecords } from '../utils/evalShared';

/** detail "return: [ra] → [rb]" から pre/post の返り式を復元。入力: detail文字列 / 出力: {ra,rb} or null */
function parseReturnDetail(detail: string): { ra: string; rb: string } | null {
  const matched = detail.match(/^return: \[([\s\S]*)\] → \[([\s\S]*)\]$/);
  return matched ? { ra: matched[1], rb: matched[2] } : null;
}

/** 返り式の本数（|| 区切りのセグメント数。空なら0）を数える */
const countSegments = (expr: string): number => (expr.trim() === '' ? 0 : expr.split('||').length);

/** return-changed 候補の内部兆候（返り値ドロップ/セグメント増減）を fail/succ 別に集計（records.json 由来 → return_analysis.json） */
function runReturnAnalysis(): void {
  const records = loadRecords().filter(r => r.status === 'evaluated');

  // 兆候キー → {fail=正解損失あり, succ=正解損失なし}
  const tally: Record<string, { fail: number; succ: number }> = {};
  const bump = (key: string, loss: boolean) => { (tally[key] ??= { fail: 0, succ: 0 })[loss ? 'fail' : 'succ']++; };

  for (const record of records) {
    const returnChanges = record.candidates.filter(c => c.tag === 'return-changed');
    if (returnChanges.length === 0) continue;

    // ペア単位で最も強い兆候を1つ選ぶ
    let signal = 'text-only';
    for (const change of returnChanges) {
      const parsed = parseReturnDetail(change.detail ?? '');
      if (!parsed) continue;
      const preCount = countSegments(parsed.ra);
      const postCount = countSegments(parsed.rb);
      if (postCount === 0 && preCount > 0) { signal = 'return-dropped(post空)'; break; }
      if (preCount === 0 && postCount > 0) signal = 'return-added(pre空)';
      else if (postCount < preCount) { if (signal === 'text-only') signal = 'seg-decreased'; }
      else if (postCount > preCount) { if (signal === 'text-only') signal = 'seg-increased'; }
    }
    bump(signal, record.loss);
  }

  const rows = Object.entries(tally)
    .map(([key, v]) => ({ key, fail: v.fail, succ: v.succ, total: v.fail + v.succ, failRate: +(v.fail / (v.fail + v.succ)).toFixed(3) }))
    .sort((a, b) => b.total - a.total);
  console.log('=== return-changed ペアの兆候別 内訳（fail=TP寄与, succ=FP寄与）===');
  console.table(rows);
  const outputDir = path.resolve(process.cwd(), ANALYSIS_DIR, 'returnAnalysis');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'return_analysis.json'), JSON.stringify(rows, null, 2));
  console.log(`[Done] ${outputDir}/return_analysis.json`);
}

if (process.argv[1] && /returnAnalysis\.(ts|js)$/.test(process.argv[1])) {
  runReturnAnalysis();
}

export { runReturnAnalysis };
