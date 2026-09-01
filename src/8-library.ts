import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from './utils/output_json';
import DiffSurface from './libDiff/diffSurface';
import LibRepo from './libDiff/libRepo';
import { extractRepositoryUrl } from './collectDataset/npm/registry';
import { CLONE_BASE, toDirName, fetchPackument, buildSurfaceForVersion, LossCandidate, PatternRecord } from './utils/evalShared';
import { generatePatterns } from './patternGen/generatePatterns';

// 8 ライブラリ（version ペア）だけで pattern 生成を回して目視できるようにする実行スクリプト
//   入力: ../../datasets/targets.json / clonedata/lib_versions/<lib>（既存クローンを使う）
//   出力: メインパイプライン(outputs/latest/BC-LC)と同形式（library-detect/records.json ＋ patterns/patterns.json ＋ summary.json）
//   実行: cd src && npx tsx 8-library.ts

const RUN_ID: string = process.env.BCPG_RUN_ID ?? OutputJson.formatDateTime(new Date());
const TARGETS_PATH = '../../datasets/targets.json';
const LATEST_BASE = '../../outputs/latest/BC-LC-8lib';
const HISTORY_BASE = `../../outputs/history/BC-LC-8lib/${RUN_ID}`;

interface Target {
  libName: string;
  preVersion: string;
  postVersion: string;
}

// 損失検出レコード（メイン library-detect/records.json と同形式。8lib は client GT が無いため GT 列は持たない）
interface DetectRecord8lib {
  npm_pkg: string;
  prevVersion: string;
  updatedVersion: string;
  status: 'evaluated' | 'surface-failed';
  candidates: LossCandidate[];   // {tag, detail, confidence}（メイン records の candidates と同形）
}

// 1ペアの処理結果（records / patterns 用の生データ ＋ ログ集計）
interface PairResult {
  record: DetectRecord8lib;
  patternRecord: PatternRecord;
  byTag: Record<string, number>;
}

const cleanVersion = (v: string): string => v.replace(/[^a-zA-Z0-9]/g, '');

/** latest 側へ JSON を書く（ディレクトリは自動生成）。入力: 相対サブパス / data / 出力: 書いた絶対パス */
function writeLatest(relPath: string, data: unknown): string {
  const out = path.resolve(process.cwd(), LATEST_BASE, relPath);
  OutputJson.createOutputDirectory(path.dirname(out));
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  return out;
}

/** 1 ペアを処理して損失候補・パターンを生成する。入力: Target / 出力: PairResult */
async function runPair(target: Target): Promise<PairResult> {
  const { libName, preVersion, postVersion } = target;
  const repoDir = path.resolve(process.cwd(), CLONE_BASE, toDirName(libName));
  const packument = await fetchPackument(libName);

  // 既存クローンを使う。無ければ repository URL から用意（データセットは触らず clonedata のみ）
  if (!fs.existsSync(repoDir)) {
    const repoUrl = packument ? extractRepositoryUrl(packument?.versions?.[postVersion] ?? packument) : null;
    if (repoUrl) LibRepo.ensureClone(repoUrl, repoDir, process.env.GITHUB_TOKEN);
  }

  const preSurface = await buildSurfaceForVersion(repoDir, preVersion, packument?.versions?.[preVersion]?.gitHead);
  const postSurface = await buildSurfaceForVersion(repoDir, postVersion, packument?.versions?.[postVersion]?.gitHead);

  const idPair = { npm_pkg: libName, prevVersion: preVersion, updatedVersion: postVersion };
  if (!preSurface || !postSurface) {
    return {
      record: { ...idPair, status: 'surface-failed', candidates: [] },
      patternRecord: { ...idPair, patterns: [], skippedTags: [] },
      byTag: {},
    };
  }

  const fullCandidates = DiffSurface.diffSurface(preSurface, postSurface, libName);
  const candidates: LossCandidate[] = fullCandidates.map((c: any) => ({ tag: c.tag, detail: c.detail ?? c.label ?? '', confidence: c.confidence ?? '' }));
  const { patterns, skipped } = generatePatterns(fullCandidates, preSurface, postSurface);

  const byTag: Record<string, number> = {};
  for (const c of fullCandidates) byTag[c.tag] = (byTag[c.tag] ?? 0) + 1;

  return {
    record: { ...idPair, status: 'evaluated', candidates },
    patternRecord: { ...idPair, patterns, skippedTags: [...new Set(skipped.map(s => s.tag))] },
    byTag,
  };
}

/** latest/BC-LC-8lib を history/BC-LC-8lib/<RUN_ID> に退避（履歴は消さず積む） */
function archive(): void {
  const latest = path.resolve(process.cwd(), LATEST_BASE);
  const history = path.resolve(process.cwd(), HISTORY_BASE);
  if (!fs.existsSync(latest)) return;
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.cpSync(latest, history, { recursive: true });
  console.log(`[Archive] → ${history}`);
}

async function main(): Promise<void> {
  const targetsPath = path.resolve(process.cwd(), TARGETS_PATH);
  const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf-8')) as Target[];
  console.log(`[8-library] targets=${targets.length} (${targetsPath})`);

  const records: DetectRecord8lib[] = [];
  const patternRecords: PatternRecord[] = [];
  const reports: any[] = [];

  for (const target of targets) {
    const { record, patternRecord, byTag } = await runPair(target);
    records.push(record);
    patternRecords.push(patternRecord);
    reports.push({ ...record, ...patternRecord, candidateCount: record.candidates.length, patternCount: patternRecord.patterns.length, byTag, patterns: undefined, candidates: undefined });

    const tags = Object.entries(byTag).map(([t, n]) => `${t}:${n}`).join(' ');
    const skip = patternRecord.skippedTags.length ? ` skip[${patternRecord.skippedTags.join(',')}]` : '';
    console.log(`  ${target.libName} ${target.preVersion}→${target.postVersion} [${record.status}] ` +
      `candidates=${record.candidates.length} patterns=${patternRecord.patterns.length} {${tags}}${skip}`);
  }

  // メインパイプラインと同じ形式・ディレクトリ名で出力（library-detect/ ＋ patterns/）
  writeLatest('library-detect/records.json', records);
  writeLatest('patterns/patterns.json', patternRecords);
  writeLatest('summary.json', { runId: RUN_ID, generatedAt: new Date().toISOString(), reports });
  archive();
  console.log(`[Done] latest=${path.resolve(process.cwd(), LATEST_BASE)}`);
}

main().catch((e) => { console.error('[Fatal]', e); process.exit(1); });
