import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import DiffSurface from '../libDiff/diffSurface';
import LibRepo from '../libDiff/libRepo';
import ApiScope from '../libDiff/apiScope';
import type { ScopeMode, ApiUsage, ApiSurface } from '../types/LibDiff';
import { extractRepositoryUrl } from '../collectDataset/npm/registry';
import {
  CLONE_BASE, EVAL_DIR, GroundTruthPair, toDirName,
  loadGroundTruth, groupByLib, fetchPackument, computeMetrics, buildSurfaceForVersion, emptyUsage,
} from '../utils/evalShared';

const MODES: ScopeMode[] = [0, 1, 2, 3];
const MODE_LABEL: Record<ScopeMode, string> = { 0: '0 全export', 1: '1 test由来', 2: '2 README由来', 3: '3 全md由来' };

// 1バージョンの surface と、各モードの絞り込み用の使用実態
interface VersionData {
  surface: ApiSurface;
  testUsage: ApiUsage;
  readmeUsage: ApiUsage;
  allMarkdownUsage: ApiUsage;
}

/** モードに対応する使用実態を返す（mode0 は絞り込みなし＝空 usage） */
const usageForMode = (data: VersionData, mode: ScopeMode): ApiUsage =>
  mode === 1 ? data.testUsage : mode === 2 ? data.readmeUsage : mode === 3 ? data.allMarkdownUsage : emptyUsage();

/** 外部API絞り込みモード0/1/2/3 ごとに P2 の損失判定精度を比較し scope_compare.json を出力 */
export async function runScopeCompare(maxLibs: number = Infinity): Promise<void> {
  const pairsByLib = groupByLib(loadGroundTruth());
  const libNames = [...pairsByLib.keys()].slice(0, maxLibs);

  const confusionByMode: Record<ScopeMode, { tp: number; fp: number; fn: number; tn: number }> =
    { 0: { tp: 0, fp: 0, fn: 0, tn: 0 }, 1: { tp: 0, fp: 0, fn: 0, tn: 0 }, 2: { tp: 0, fp: 0, fn: 0, tn: 0 }, 3: { tp: 0, fp: 0, fn: 0, tn: 0 } };
  let analyzable = 0;
  let unavailable = 0;

  let libIndex = 0;
  for (const libName of libNames) {
    libIndex++;
    const libPairs = pairsByLib.get(libName)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, toDirName(libName));
    process.stderr.write(`\r[${libIndex}/${libNames.length}] ${libName}            `);

    const packument = await fetchPackument(libName);
    if (!fs.existsSync(repoDir)) {
      const repoUrl = packument ? extractRepositoryUrl(packument?.versions?.[libPairs[0].updatedVersion] ?? packument) : null;
      if (!repoUrl) { unavailable += libPairs.length; continue; }
      try { LibRepo.ensureClone(repoUrl, repoDir, process.env.GITHUB_TOKEN); }
      catch { unavailable += libPairs.length; continue; }
    }

    // バージョン→ surface＋使用実態を1回だけ作りキャッシュ（buildSurfaceForVersion が checkout も行う）
    const versionCache = new Map<string, VersionData | null>();
    const getVersionData = async (version: string): Promise<VersionData | null> => {
      if (versionCache.has(version)) return versionCache.get(version)!;
      const surface = await buildSurfaceForVersion(repoDir, version, packument?.versions?.[version]?.gitHead);
      if (!surface) { versionCache.set(version, null); return null; }
      const data: VersionData = {
        surface,
        testUsage: ApiScope.collectTestUsage(repoDir, libName),      // test: import 追跡(AST)
        readmeUsage: ApiScope.collectDocTokens(repoDir, true),        // README: 名前トークン照合
        allMarkdownUsage: ApiScope.collectDocTokens(repoDir, false),  // 全md(CHANGELOG等含む): 名前トークン照合
      };
      versionCache.set(version, data);
      return data;
    };

    for (const pair of libPairs) {
      const pre = await getVersionData(pair.prevVersion);
      const post = await getVersionData(pair.updatedVersion);
      if (!pre || !post) { unavailable++; continue; }
      analyzable++;
      for (const mode of MODES) {
        const preFiltered = ApiScope.filterSurface(pre.surface, mode, usageForMode(pre, mode));
        const postFiltered = ApiScope.filterSurface(post.surface, mode, usageForMode(post, mode));
        const predictedLoss = DiffSurface.diffSurface(preFiltered, postFiltered, libName).length > 0;
        const confusion = confusionByMode[mode];
        if (pair.loss && predictedLoss) confusion.tp++;
        else if (pair.loss && !predictedLoss) confusion.fn++;
        else if (!pair.loss && predictedLoss) confusion.fp++;
        else confusion.tn++;
      }
    }
  }
  process.stderr.write('\n');

  const modeRows = MODES.map(mode => ({ mode: MODE_LABEL[mode], ...confusionByMode[mode], ...computeMetrics(confusionByMode[mode]) }));
  const summary = { analyzable, unavailable, modes: modeRows };
  const outputDir = path.resolve(process.cwd(), EVAL_DIR);
  OutputJson.createOutputDirectory(outputDir);
  fs.writeFileSync(path.join(outputDir, 'scope_compare.json'), JSON.stringify(summary, null, 2));
  console.log(`analyzable=${analyzable} unavailable=${unavailable}`);
  console.table(modeRows);
  console.log(`[Done] ${outputDir}/scope_compare.json`);
}

if (process.argv[1] && /scopeCompare\.(ts|js)$/.test(process.argv[1])) {
  const maxLibs = process.argv[2] ? Number(process.argv[2]) : Infinity;
  runScopeCompare(maxLibs).catch(e => { console.error('[Fatal]', e); process.exit(1); });
}
