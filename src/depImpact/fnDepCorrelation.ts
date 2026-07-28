import { DetectionRecord, loadRecords, writeSampleResult } from '../utils/evalShared';

type Category = 'TP' | 'FP' | 'FN' | 'TN';

/** 検出事実1件の category（loss × predictedLoss）。predictedLoss は candidates のみで決める */
function categoryOf(record: DetectionRecord): Category {
  const predictedLoss = record.candidates.length > 0;
  return record.loss ? (predictedLoss ? 'TP' : 'FN') : (predictedLoss ? 'FP' : 'TN');
}

const hasDepChange = (r: DetectionRecord) => (r.depChanges?.length ?? 0) > 0;
const hasMajorBump = (r: DetectionRecord) => (r.depChanges ?? []).some(d => d.change === 'major-bump');

/** 分子/分母から割合(3桁)を出す */
const rate = (num: number, den: number) => (den > 0 ? +(num / den).toFixed(3) : 0);

/**
 * 「間接依存起因の見落とし」の識別力を測る
 *   category(TP/FP/FN/TN)別に depChange 有り率・major-bump 有り率を集計し，
 *   FN(見逃し) と TN(正しく損失なし) を比較する（FN≫TN のとき依存 bump は有効な signal）
 *   出力: BC-sample/depImpact/fn_dep_correlation.json
 */
function runFnDepCorrelation(): void {
  const evaluated = loadRecords().filter(r => r.status === 'evaluated');

  const categories: Category[] = ['TP', 'FP', 'FN', 'TN'];
  const perCategory = categories.map(category => {
    const rows = evaluated.filter(r => categoryOf(r) === category);
    const withDepChange = rows.filter(hasDepChange).length;
    const withMajorBump = rows.filter(hasMajorBump).length;
    return {
      category,
      pairs: rows.length,
      withDepChange,
      depChangeRate: rate(withDepChange, rows.length),
      withMajorBump,
      majorBumpRate: rate(withMajorBump, rows.length),
    };
  });

  const fn = perCategory.find(r => r.category === 'FN')!;
  const tn = perCategory.find(r => r.category === 'TN')!;

  // FN ペアで実際に major-bump した依存を列挙（目視・原因あたり付け用）
  const fnMajorBumps = evaluated
    .filter(r => categoryOf(r) === 'FN' && hasMajorBump(r))
    .map(r => ({
      lib: r.npm_pkg,
      prevVersion: r.prevVersion,
      updatedVersion: r.updatedVersion,
      majorBumped: (r.depChanges ?? [])
        .filter(d => d.change === 'major-bump')
        .map(d => `${d.name} ${d.preRange} → ${d.postRange} (${d.kind})`),
    }));

  const summary = {
    note: 'FN=見逃し / TN=正しく損失なし。FN の major-bump 率が TN より十分高いとき，依存 bump は見落としを説明する識別力のある signal',
    verdict: {
      fnMajorBumpRate: fn.majorBumpRate,
      tnMajorBumpRate: tn.majorBumpRate,
      lift: tn.majorBumpRate > 0 ? +(fn.majorBumpRate / tn.majorBumpRate).toFixed(2) : null, // FN率 / TN率
    },
    perCategory,
    fnMajorBumps,
  };

  console.table(perCategory);
  console.log(`FN major-bump 率=${fn.majorBumpRate} vs TN=${tn.majorBumpRate} (lift=${summary.verdict.lift})`);
  const outPath = writeSampleResult('depImpact', 'fn_dep_correlation.json', summary);
  console.log(`[Done] ${outPath}`);
}

if (process.argv[1] && /fnDepCorrelation\.(ts|js)$/.test(process.argv[1])) {
  runFnDepCorrelation();
}

export { runFnDepCorrelation };
