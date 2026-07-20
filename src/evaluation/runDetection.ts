import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import ApiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import LibRepo from '../libDiff/libRepo';
import RunLogger from '../utils/runLogger';
import { extractRepositoryUrl } from '../collectDataset/npm/registry';
import { diffDeps } from '../depImpact/depDiff';
import {
  CLONE_BASE, DETECTION_DIR, AUDIT_DIR, GroundTruthPair, DetectionRecord, LossCandidate,
  toDirName, loadGroundTruth, groupByLib, fetchPackument,
} from '../utils/evalShared';

// 1バージョンの surface 取得結果（reason で「なぜ評価不能か」を表す）
interface SurfaceResult {
  surface: any | null;
  reason: 'ok' | 'ref-unresolved' | 'build-error' | 'empty';
}

/**
 * ground_truth 全ペアに P2 検出（clone→surface→diff）を1回だけ実行し，
 * 損失候補を records.json に書き出す。採点(compare)/分析(analysis)はこの出力を読むだけ
 *   入力: maxLibs（先頭N libのパイロット用。既定=全件）
 *   出力: detection/records.json（DetectionRecord 配列）＋ audit/ に解決ログ
 */
export async function runDetection(maxLibs: number = Infinity): Promise<void> {
  const logger = new RunLogger(); // バージョン解決手段・警告・エラーを監査ファイルに残す

  // 同じ lib は1回だけ clone し surface を共有するため lib 単位でまとめる
  const pairsByLib = groupByLib(loadGroundTruth());
  const libNames = [...pairsByLib.keys()].slice(0, maxLibs);
  console.log(`[runDetection] libs=${libNames.length} (全${pairsByLib.size}), pairs=${libNames.reduce((n, l) => n + pairsByLib.get(l)!.length, 0)}`);

  const records: DetectionRecord[] = [];
  const excludedRecord = (pair: GroundTruthPair, reason: string): DetectionRecord =>
    ({ ...pair, status: 'excluded', reason, candidates: [] });

  let libIndex = 0;
  for (const libName of libNames) {
    libIndex++;
    const libPairs = pairsByLib.get(libName)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, toDirName(libName));
    process.stderr.write(`\r[${libIndex}/${libNames.length}] ${libName} (${libPairs.length} pairs)            `);

    const packument = await fetchPackument(libName);
    if (!packument) logger.warn(libName, '-', 'registry', 'npm registry doc 取得失敗（gitHead フォールバック不可）');

    // クローン準備（未クローンなら repository URL を得て clone）
    if (!fs.existsSync(repoDir)) {
      const repoUrl = packument ? extractRepositoryUrl(packument?.versions?.[libPairs[0].updatedVersion] ?? packument) : null;
      if (!repoUrl) {
        logger.error(libName, '-', 'clone', 'repository URL を特定できず（no-repo-url）');
        for (const pair of libPairs) records.push(excludedRecord(pair, 'no-repo-url'));
        continue;
      }
      try {
        LibRepo.ensureClone(repoUrl, repoDir, process.env.GITHUB_TOKEN);
      } catch (e: any) {
        logger.error(libName, '-', 'clone', `clone 失敗: ${e?.message ?? e}`);
        for (const pair of libPairs) records.push(excludedRecord(pair, 'clone-failed'));
        continue;
      }
    }

    // バージョン文字列 → surface を1回だけ抽出してキャッシュ（reason 付き）
    // repoDir / packument / surfaceCache をクロージャで捕捉するためローカルのアロー関数にしている
    const surfaceCache = new Map<string, SurfaceResult>();
    const getSurface = async (version: string): Promise<SurfaceResult> => {
      const cached = surfaceCache.get(version);
      if (cached) return cached;

      // どの commit に checkout するか（tag→package.json→gitHead→commit-message の順）を解決
      const { ref: commitRef, method: commitResolveMethod } = LibRepo.resolveRefDetailed(repoDir, version, packument?.versions?.[version]?.gitHead);
      logger.resolution(libName, version, commitResolveMethod, commitRef);

      let result: SurfaceResult;
      if (!commitRef) {
        logger.error(libName, version, 'resolve', 'tag/package.json/gitHead/commit-message いずれでも checkout 先 commit を特定できず');
        result = { surface: null, reason: 'ref-unresolved' };
      } else {
        if (commitResolveMethod === 'git-head' || commitResolveMethod === 'commit-message') {
          logger.warn(libName, version, 'resolve', `低信頼な手段で解決(${commitResolveMethod}) ref=${commitRef.slice(0, 12)}（要目視確認）`);
        }
        try {
          LibRepo.checkoutVersion(repoDir, commitRef);
          const surface = await ApiSurface.buildApiSurface(repoDir, version, commitRef);
          if (surface.symbols.length === 0) {
            logger.warn(libName, version, 'surface', `export 関数が0件（抽出漏れ/ビルド成果物未コミット等）ref=${commitRef.slice(0, 12)}`);
            result = { surface, reason: 'empty' };
          } else {
            result = { surface, reason: 'ok' };
          }
        } catch (e: any) {
          logger.error(libName, version, 'surface', `checkout/解析 失敗: ${e?.message ?? e}`);
          result = { surface: null, reason: 'build-error' };
        }
      }
      surfaceCache.set(version, result);
      return result;
    };

    for (const pair of libPairs) {
      const preSurface = await getSurface(pair.prevVersion);
      const postSurface = await getSurface(pair.updatedVersion);

      // どちらかのバージョンが評価不能なら除外（どのバージョンが何の理由かを記録）
      if (preSurface.reason !== 'ok' || postSurface.reason !== 'ok') {
        const reasonParts: string[] = [];
        if (preSurface.reason !== 'ok') reasonParts.push(`pre(${pair.prevVersion}):${preSurface.reason}`);
        if (postSurface.reason !== 'ok') reasonParts.push(`post(${pair.updatedVersion}):${postSurface.reason}`);
        records.push(excludedRecord(pair, reasonParts.join(' / ')));
        continue;
      }

      const candidates: LossCandidate[] = DiffSurface.diffSurface(preSurface.surface, postSurface.surface, libName)
        .map((c: any) => ({ tag: c.tag, detail: c.detail ?? c.label ?? '', confidence: c.confidence ?? '' }));
      // 依存 range 変化を signal として別枠で記録（採点は candidates のみ・depChanges は不使用）
      const depChanges = diffDeps(packument?.versions?.[pair.prevVersion], packument?.versions?.[pair.updatedVersion]);
      records.push({ ...pair, status: 'evaluated', reason: 'ok', candidates, depChanges });
    }
  }
  process.stderr.write('\n');

  const outputDir = path.resolve(process.cwd(), DETECTION_DIR);
  OutputJson.createOutputDirectory(outputDir);
  fs.writeFileSync(path.join(outputDir, 'records.json'), JSON.stringify(records, null, 2));

  logger.flush(path.resolve(process.cwd(), AUDIT_DIR), 'runDetection'); // 監査ログは audit/ へ
  const evaluated = records.filter(r => r.status === 'evaluated').length;
  console.log(`[Done] records=${records.length} (evaluated=${evaluated}, excluded=${records.length - evaluated}) → ${outputDir}/records.json`);
}

// CLI 直接実行時のみ走らせる（import 時は走らせない）
if (process.argv[1] && /runDetection\.(ts|js)$/.test(process.argv[1])) {
  const maxLibs = process.argv[2] ? Number(process.argv[2]) : Infinity;
  runDetection(maxLibs).catch(e => { console.error('[Fatal]', e); process.exit(1); });
}
