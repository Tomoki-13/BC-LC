import '../utils/loadEnv';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import {
  RUN_SUMMARY_DIR, LOSS_JUDGEMENT_DIR, CLIENT_DETECT_DIR, EXTRACTION_COVERAGE_DIR, PATTERNS_PATH,
  KEY_RESULTS_JSON, loadRecords, toCsvCell,
} from '../utils/evalShared';
import { RUN_SCOPE, RUN_DETECT_LEVEL, DETECT_LEVEL_NAME } from '../utils/runVariant';

// 実行全体の一番大事な数値（run_summary/key_results.json）と、バージョンペアごとのまとめ（run_summary/detail_per_version_pair.csv）を書く
//   入力: loss_judgement_accuracy/key_results.json・detected_clients/key_results.json・detected_clients/breakdown_per_version_pair_by_group.csv
//         extracted_functions_vs_dts/key_results.json・generated_patterns/all_patterns.json・intermediate_data/loss_candidates/
//   どれかが無ければ、その部分を null・空欄にして書く

const GROUP_KEYS = { 'g1-failureClient': 'g1', 'g2-successClientInFailedPair': 'g2', 'g3-successClientInSuccessPair': 'g3' } as const;
type GroupKey = typeof GROUP_KEYS[keyof typeof GROUP_KEYS];

const readJson = (p: string): any => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), p), 'utf-8'));
  } catch {
    return null;
  }
};

/** CSV の1行をセルに分ける（toCsvCell が付けた "…" と "" に対応） */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** breakdown_per_version_pair_by_group.csv から バージョンペア → 群 → {scanned, detected} */
function readGroupCounts(): Map<string, Partial<Record<GroupKey, { scanned: number; detected: number }>>> {
  const out = new Map<string, Partial<Record<GroupKey, { scanned: number; detected: number }>>>();
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(process.cwd(), CLIENT_DETECT_DIR, 'breakdown_per_version_pair_by_group.csv'), 'utf-8');
  } catch {
    return out;
  }
  const [headLine, ...lines] = text.trim().split('\n');
  const head = splitCsvLine(headLine);
  const col = (name: string) => head.indexOf(name);
  for (const line of lines) {
    const c = splitCsvLine(line);
    const g = GROUP_KEYS[c[col('client_group')] as keyof typeof GROUP_KEYS];
    if (!g) continue;
    const key = [c[col('library')], c[col('prevVersion')], c[col('updatedVersion')]].join('|');
    const entry = out.get(key) ?? {};
    entry[g] = { scanned: Number(c[col('clients_scanned')]) || 0, detected: Number(c[col('clients_detected')]) || 0 };
    out.set(key, entry);
  }
  return out;
}

/** 群ごとの検出の要点（g1 は recall、g2・g3 は detectionRate） */
function groupResult(g: any) {
  if (!g) return null;
  const rate = g.recall ?? g.detectionRate ?? null;
  const onlyPatterns = g.detectionOnlyInPairsWithPatterns ?? {};
  return {
    versionPairs: g.pairs ?? null,
    clientsScanned: g.scanned ?? null,
    clientsDetected: g.detected ?? null,
    rate,
    clientsScannedOnlyInPairsWithPatterns: onlyPatterns.scanned ?? null,
    rateOnlyInPairsWithPatterns: onlyPatterns.recall ?? onlyPatterns.detectionRate ?? null,
    clientsDetectedWithoutDependencyBreakingChange: g.withoutDependencyBreakingChange?.detected ?? null,
    rateWithoutDependencyBreakingChange: g.withoutDependencyBreakingChange?.recall ?? g.withoutDependencyBreakingChange?.detectionRate ?? null,
  };
}

export function runRunSummary(): void {
  const loss = readJson(`${LOSS_JUDGEMENT_DIR}/${KEY_RESULTS_JSON}`);
  const detect = readJson(`${CLIENT_DETECT_DIR}/${KEY_RESULTS_JSON}`);
  const dts = readJson(`${EXTRACTION_COVERAGE_DIR}/${KEY_RESULTS_JSON}`);
  const patternRecords: { npm_pkg: string; prevVersion: string; updatedVersion: string; patterns: unknown[] }[] = readJson(PATTERNS_PATH) ?? [];
  const patternsOf = new Map(patternRecords.map(r => [`${r.npm_pkg}|${r.prevVersion}|${r.updatedVersion}`, r.patterns.length]));

  const groups = Object.fromEntries(Object.entries(GROUP_KEYS).map(([name, key]) => [key, groupResult(detect?.groups?.[name])]));
  const g1 = groups.g1, g3 = groups.g3;
  const keyResults = {
    mode: { scope: RUN_SCOPE, detect: DETECT_LEVEL_NAME[RUN_DETECT_LEVEL] },
    lossJudgement: loss ? {
      versionPairsInMatrix: loss.matrixTotal,
      groundTruth: loss.groundTruth,
      confusion: loss.confusion,
      metrics: loss.metrics,
      withDependency: loss.withDependency ?? null,
    } : null,
    clientDetection: detect ? {
      ...groups,
      g1RateOverG3Rate: g1?.clientsScanned && g3?.clientsScanned && g3.clientsDetected
        ? +((g1.clientsDetected / g1.clientsScanned) / (g3.clientsDetected / g3.clientsScanned)).toFixed(2) : null,
    } : null,
    generatedPatterns: {
      versionPairsWithPatterns: patternRecords.filter(r => r.patterns.length > 0).length,
      patterns: patternRecords.reduce((n, r) => n + r.patterns.length, 0),
    },
    extractedFunctionsVsDts: dts ? {
      versionsChecked: dts.versionsChecked,
      versionsWithDts: dts.withDts,
      nameCoverage: dts.nameCoverage,
    } : null,
  };

  const groupCounts = readGroupCounts();
  const header = ['library', 'prev_version', 'updated_version', 'test_result', 'analysis_status', 'predicted_loss', 'category',
    'loss_tags', 'loss_candidates', 'dependency_candidates', 'category_with_dependency', 'patterns',
    'g1_clients_scanned', 'g1_clients_detected', 'g2_clients_scanned', 'g2_clients_detected', 'g3_clients_scanned', 'g3_clients_detected'];
  let records: ReturnType<typeof loadRecords> = [];
  try {
    records = loadRecords();
  } catch { /* 損失候補が無ければバージョンペアの行は書かない */ }
  // 依存パッケージを調べた実行なら，範囲が変わった依存パッケージが無いバージョンペアも「問題なし」として区分を入れる
  const dependencyAnalyzed = records.some(r => r.dependencyChecks !== undefined);
  const rows = records.map(r => {
    const key = `${r.npm_pkg}|${r.prevVersion}|${r.updatedVersion}`;
    const external = r.analyzability === 'external';
    const predicted = r.candidates.length > 0;
    const category = external ? '' : r.lossByClientTest ? (predicted ? 'TP' : 'FN') : (predicted ? 'FP' : 'TN');
    const dependencyCount = r.dependencyCandidates?.length ?? 0;
    const predictedWithDependency = predicted || dependencyCount > 0;
    const categoryWithDependency = external || !dependencyAnalyzed ? '' : r.lossByClientTest ? (predictedWithDependency ? 'TP' : 'FN') : (predictedWithDependency ? 'FP' : 'TN');
    const gc = groupCounts.get(key) ?? {};
    const cells = (g: GroupKey) => [gc[g]?.scanned ?? '', gc[g]?.detected ?? ''];
    return [r.npm_pkg, r.prevVersion, r.updatedVersion, r.state, r.status === 'evaluated' ? 'evaluated' : `${r.status}:${r.reason}`,
      external ? '' : predicted ? 'yes' : 'no', category,
      [...new Set(r.candidates.map(c => c.tag))].sort().join(';'), r.candidates.length, dependencyAnalyzed && !external ? dependencyCount : '', categoryWithDependency, patternsOf.get(key) ?? 0,
      ...cells('g1'), ...cells('g2'), ...cells('g3')].map(toCsvCell).join(',');
  });

  const outDir = path.resolve(process.cwd(), RUN_SUMMARY_DIR);
  OutputJson.createOutputDirectory(outDir);
  fs.writeFileSync(path.join(outDir, KEY_RESULTS_JSON), JSON.stringify(keyResults, null, 2));
  fs.writeFileSync(path.join(outDir, 'detail_per_version_pair.csv'), [header.join(','), ...rows].join('\n') + '\n');
  console.log(`[Done] run summary → ${outDir}`);
}

// CLI 直接実行時のみ走らせる（import 時は走らせない）
if (process.argv[1] && /runSummary\.(ts|js)$/.test(process.argv[1])) {
  runRunSummary();
}
