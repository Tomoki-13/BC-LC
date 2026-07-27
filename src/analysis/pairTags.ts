import fs from 'fs';
import path from 'path';

import { ANALYSIS_DIR, DetectionRecord, loadRecords } from '../utils/evalShared';

const PAIRTAGS_DIR = path.resolve(process.cwd(), ANALYSIS_DIR, 'pairTags');

// 1ペアの検出結果（tags=重複排除タグ / confidences=confidence集合 / loss=正解）
interface PairTags {
  lib: string;
  prevVersion: string;
  updatedVersion: string;
  loss: boolean;
  tags: string[];
  confidences: string[];
}

/** records.json の評価済みペアを PairTags 形へ（タグ/confidence を重複排除） */
const toPairTags = (records: DetectionRecord[]): PairTags[] =>
  records.filter(r => r.status === 'evaluated').map(r => ({
    lib: r.npm_pkg,
    prevVersion: r.prevVersion,
    updatedVersion: r.updatedVersion,
    loss: r.loss,
    tags: [...new Set(r.candidates.map(c => c.tag))],
    confidences: [...new Set(r.candidates.map(c => c.confidence))],
  }));

/** 「何を損失とみなすか」のポリシーで混同行列を計算。入力: 記録配列/名前/損失判定関数 / 出力: 指標付き行 */
function evalPolicy(records: PairTags[], name: string, isLoss: (r: PairTags) => boolean) {
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const record of records) {
    const predicted = isLoss(record);
    if (record.loss && predicted) m.tp++;
    else if (record.loss && !predicted) m.fn++;
    else if (!record.loss && predicted) m.fp++;
    else m.tn++;
  }
  const precision = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0;
  const recall = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = records.length ? (m.tp + m.tn) / records.length : 0;
  return { name, ...m, precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: +f1.toFixed(3), accuracy: +accuracy.toFixed(3) };
}

/** 複数の損失定義ポリシーで混同行列を比較する（records.json 由来 → policy_sweep.json） */
function runPairTags(): void {
  const records = toPairTags(loadRecords());

  const hasAnyTag = (r: PairTags, tags: string[]) => r.tags.some(t => tags.includes(t));
  const NOISE_TAGS = ['return-changed', 'export-style-changed'];
  const policies = [
    evalPolicy(records, 'P0 現行(候補≥1)', r => r.tags.length > 0),
    evalPolicy(records, 'P1 structural のみ', r => r.confidences.includes('structural')),
    evalPolicy(records, 'P2 return-changed 除外', r => r.tags.filter(t => t !== 'return-changed').length > 0),
    evalPolicy(records, 'P3 return+export-style 除外', r => r.tags.filter(t => !NOISE_TAGS.includes(t)).length > 0),
    evalPolicy(records, 'P4 structural OR (return-changed 単独でない)', r =>
      r.confidences.includes('structural') || (r.tags.includes('return-changed') && r.tags.length > 1)),
    evalPolicy(records, 'P5 function-removed + arg系のみ', r =>
      hasAnyTag(r, ['function-removed', 'arg-added', 'arg-removed', 'arg-reordered'])),
  ];

  console.log(`analyzable=${records.length}  GT_fail=${records.filter(r => r.loss).length}  GT_succ=${records.filter(r => !r.loss).length}`);
  console.table(policies);
  fs.mkdirSync(PAIRTAGS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PAIRTAGS_DIR, 'pair_tags.json'), JSON.stringify(records));
  fs.writeFileSync(path.join(PAIRTAGS_DIR, 'policy_sweep.json'), JSON.stringify(policies, null, 2));
  console.log(`[Done] ${PAIRTAGS_DIR}/{pair_tags.json, policy_sweep.json}`);
}

if (process.argv[1] && /pairTags\.(ts|js)$/.test(process.argv[1])) {
  runPairTags();
}

export { runPairTags };
