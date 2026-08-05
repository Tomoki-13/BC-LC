import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from './utils/output_json';
import DiffSurface from './libDiff/diffSurface';
import LibRepo from './libDiff/libRepo';
import { extractRepositoryUrl } from './collectDataset/npm/registry';
import { CLONE_BASE, toDirName, fetchPackument, buildSurfaceForVersion } from './utils/evalShared';
import { generatePatterns } from './patternGen/generatePatterns';
import type { GeneratedPattern } from './patternGen/patternTypes';

// 8 ライブラリ（version ペア）だけで pattern 生成を回して目視できるようにする実行スクリプト
//   入力: ../../datasets/targets.json / clonedata/lib_versions/<lib>（既存クローンを使う）
//   出力: R-BC 形式のパターン(GeneratedPattern[]=calls + BC-LC ラベル) を latest/history に BC-LC-8lib として記録
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

interface PairReport {
  libName: string;
  preVersion: string;
  postVersion: string;
  status: 'ok' | 'surface-failed';
  candidateCount: number;
  patternCount: number;
  byTag: Record<string, number>;      // candidate の tag 別内訳
  skippedTags: string[];              // 変換器未対応で飛ばした tag
}

const cleanVersion = (v: string): string => v.replace(/[^a-zA-Z0-9]/g, '');
const pairDirName = (t: Target): string => `${toDirName(t.libName)}__${cleanVersion(t.preVersion)}__${cleanVersion(t.postVersion)}`;

/** latest 側へ JSON を書く（ディレクトリは自動生成）。入力: 相対サブパス / data / 出力: 書いた絶対パス */
function writeLatest(relPath: string, data: unknown): string {
  const out = path.resolve(process.cwd(), LATEST_BASE, relPath);
  OutputJson.createOutputDirectory(path.dirname(out));
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  return out;
}

/** 1 ペアを処理して pattern を生成・出力する。入力: Target / 出力: PairReport */
async function runPair(target: Target): Promise<PairReport> {
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

  const base: PairReport = {
    libName, preVersion, postVersion, status: 'ok', candidateCount: 0, patternCount: 0, byTag: {}, skippedTags: [],
  };
  if (!preSurface || !postSurface) return { ...base, status: 'surface-failed' };

  const candidates = DiffSurface.diffSurface(preSurface, postSurface, libName);
  const { patterns, skipped } = generatePatterns(candidates, preSurface, postSurface);

  const byTag: Record<string, number> = {};
  for (const c of candidates) byTag[c.tag] = (byTag[c.tag] ?? 0) + 1;
  const skippedTags = [...new Set(skipped.map(s => s.tag))];

  // R-BC 形式パターン(calls) に BC-LC ラベルを添えたものを出力（どの損失のパターンか判別できる）
  const dir = pairDirName(target);
  writeLatest(path.join(dir, 'patterns.json'), patterns as GeneratedPattern[]);
  writeLatest(path.join(dir, 'candidates.json'), candidates);
  writeLatest(path.join(dir, 'skipped.json'), skipped);

  return { ...base, candidateCount: candidates.length, patternCount: patterns.length, byTag, skippedTags };
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

  const reports: PairReport[] = [];
  for (const target of targets) {
    const report = await runPair(target);
    reports.push(report);
    const tags = Object.entries(report.byTag).map(([t, n]) => `${t}:${n}`).join(' ');
    const skip = report.skippedTags.length ? ` skip[${report.skippedTags.join(',')}]` : '';
    console.log(`  ${report.libName} ${report.preVersion}→${report.postVersion} [${report.status}] ` +
      `candidates=${report.candidateCount} patterns=${report.patternCount} {${tags}}${skip}`);
  }

  writeLatest('summary.json', { runId: RUN_ID, generatedAt: new Date().toISOString(), reports });
  archive();
  console.log(`[Done] latest=${path.resolve(process.cwd(), LATEST_BASE)}`);
}

main().catch((e) => { console.error('[Fatal]', e); process.exit(1); });
