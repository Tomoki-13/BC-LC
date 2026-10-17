import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import ApiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import LibRepo from '../libDiff/libRepo';
import RunLogger from '../utils/runLogger';
import { initRunLog, phase, progress, logEvent } from '../utils/runLog';
import { extractRepositoryUrl } from '../utils/npmRegistry';
import { diffDeps } from '../depImpact/depDiff';
import { generatePatterns } from '../patternGen/generatePatterns';
import {
  CLONE_BASE, LIBRARY_DETECT_DIR, PATTERNS_DIR, SURFACE_DIR, AUDIT_DIR, GroundTruthPair, DetectionRecord, LossCandidate,
  PatternRecord, toDirName, loadGroundTruth, groupByLib, fetchPackument,
  ExcludeReason, Analyzability, classifyAnalyzability,
} from '../utils/evalShared';
import type { DtsValidation } from '../types/LibDiff';

// 1バージョンの surface 取得結果（reason で「なぜ評価不能か」を表す）
interface SurfaceResult {
  surface: any | null;
  reason: 'ok' | ExcludeReason;
}

/** surface 中の1 symbol を同一判定用のキーにする（同名が複数ファイルに出るため filePath も含める） */
const symbolKey = (s: any): string => `${s.name}\u0000${s.filePath}`;

/**
 * pre/post の surface から「同じ symbol を削除した」差分だけを取り出す（人が変化点だけ見る用）
 *   pre/post どちらか片方にしか無い、または内容が異なる symbol のみを両側に残す。
 *   engines/moduleType は pre→post で変化したときだけ持つ。full は pre.json/post.json 側にあるので再判定はそちらを使う
 */
function diffSurfaceSymbols(pre: any, post: any): {
  pre: any[]; post: any[]; engines?: { pre: any; post: any }; moduleType?: { pre: any; post: any };
} {
  const preByKey = new Map<string, any>(pre.symbols.map((s: any) => [symbolKey(s), s]));
  const postByKey = new Map<string, any>(post.symbols.map((s: any) => [symbolKey(s), s]));
  const changed = (a: any, b: any) => JSON.stringify(a) !== JSON.stringify(b); // 未対応(b=undefined)も変化扱い
  const changedPre = pre.symbols.filter((s: any) => changed(s, postByKey.get(symbolKey(s))));
  const changedPost = post.symbols.filter((s: any) => changed(s, preByKey.get(symbolKey(s))));
  const out: { pre: any[]; post: any[]; engines?: any; moduleType?: any } = { pre: changedPre, post: changedPost };
  if (JSON.stringify(pre.engines ?? null) !== JSON.stringify(post.engines ?? null)) {
    out.engines = { pre: pre.engines ?? null, post: post.engines ?? null };
  }
  if ((pre.moduleType ?? null) !== (post.moduleType ?? null)) {
    out.moduleType = { pre: pre.moduleType ?? null, post: post.moduleType ?? null };
  }
  return out;
}

/**
 * ground_truth 全ペアに P2 検出（clone→surface→diff）を1回だけ実行し，
 * 損失候補を records.json に書き出す。採点(compare)/分析(analysis)はこの出力を読むだけ
 *   入力: maxLibs（先頭N libのパイロット用。既定=全件）
 *   出力: library-detect/records.json（DetectionRecord 配列＝損失有無）
 *        patterns/patterns.json（PatternRecord 配列＝R-BC 形式の検出パターン。client-detect の照合入力）
 *        audit/ に解決ログ
 */
export async function runDetection(maxLibs: number = Infinity): Promise<void> {
  phase('judge+generate');
  const logger = new RunLogger(); // バージョン解決手段・警告・エラーを監査ファイルに残す

  // 同じ lib は1回だけ clone し surface を共有するため lib 単位でまとめる
  const pairsByLib = groupByLib(loadGroundTruth());
  const libNames = [...pairsByLib.keys()].slice(0, maxLibs);
  console.log(`[runDetection] libs=${libNames.length} (全${pairsByLib.size}), pairs=${libNames.reduce((n, l) => n + pairsByLib.get(l)!.length, 0)}`);

  const records: DetectionRecord[] = [];
  const patternRecords: PatternRecord[] = []; // 損失候補 → R-BC 形式パターン（evaluated ペアのみ）
  // 損失判定に使った pre/post の API surface（evaluated ペアのみ）。<lib>/<prev>__<upd>.json に後でまとめて書く
  const surfacePairs: Array<{ npm_pkg: string; prevVersion: string; updatedVersion: string; pre: any; post: any }> = [];
  const dtsRecords: Array<{ libName: string; version: string } & DtsValidation> = []; // .d.ts 妥当性検証（版ごと）
  const excludedRecord = (pair: GroundTruthPair, reason: string, analyzability: Analyzability): DetectionRecord =>
    ({ ...pair, status: 'excluded', reason, analyzability, bcLoss: 'unevaluated', candidates: [] });

  let libIndex = 0;
  for (const libName of libNames) {
    libIndex++;
    const libPairs = pairsByLib.get(libName)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, toDirName(libName));
    process.stderr.write(`\r[${libIndex}/${libNames.length}] ${libName} (${libPairs.length} pairs)            `);
    progress({ lib: libName, libIndex, libTotal: libNames.length, step: 'clone' });

    const packument = await fetchPackument(libName);
    if (!packument) logger.warn(libName, '-', 'registry', 'npm registry doc 取得失敗（gitHead フォールバック不可）');

    // クローン準備（未クローンなら repository URL を得て clone）
    if (!fs.existsSync(repoDir)) {
      const repoUrl = packument ? extractRepositoryUrl(packument?.versions?.[libPairs[0].updatedVersion] ?? packument) : null;
      if (!repoUrl) {
        logger.error(libName, '-', 'clone', 'repository URL を特定できず（no-repo-url）');
        for (const pair of libPairs) records.push(excludedRecord(pair, 'no-repo-url', 'external'));
        continue;
      }
      try {
        LibRepo.ensureClone(repoUrl, repoDir, process.env.GITHUB_TOKEN);
      } catch (e: any) {
        logger.error(libName, '-', 'clone', `clone 失敗: ${e?.message ?? e}`);
        for (const pair of libPairs) records.push(excludedRecord(pair, 'clone-failed', 'external'));
        continue;
      }
    }

    // バージョン文字列 → surface を1回だけ抽出してキャッシュ（reason 付き）
    // repoDir / packument / surfaceCache をクロージャで捕捉するためローカルのアロー関数にしている
    const surfaceCache = new Map<string, SurfaceResult>();
    const getSurface = async (version: string): Promise<SurfaceResult> => {
      const cached = surfaceCache.get(version);
      if (cached) return cached;
      progress({ lib: libName, libIndex, libTotal: libNames.length, version, step: 'surface' });

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
          dtsRecords.push({ libName, version, ...(surface.dtsValidation ?? { hasDts: false }) }); // .d.ts 妥当性検証（抽出の網羅性）
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

      // どちらかのバージョンが評価不能なら除外（どのバージョンが何の理由か＋解析可否クラスを記録）
      if (preSurface.reason !== 'ok' || postSurface.reason !== 'ok') {
        const reasonParts: string[] = [];
        const badReasons: ExcludeReason[] = [];
        if (preSurface.reason !== 'ok') {
          reasonParts.push(`pre(${pair.prevVersion}):${preSurface.reason}`);
          badReasons.push(preSurface.reason);
        }
        if (postSurface.reason !== 'ok') {
          reasonParts.push(`post(${pair.updatedVersion}):${postSurface.reason}`);
          badReasons.push(postSurface.reason);
        }
        records.push(excludedRecord(pair, reasonParts.join(' / '), classifyAnalyzability(badReasons)));
        continue;
      }

      // diffSurface のフル候補（symbol/filePath/label を含む）を1回だけ取り，records と pattern 生成で共用
      const fullCandidates = DiffSurface.diffSurface(preSurface.surface, postSurface.surface, libName);
      const candidates: LossCandidate[] = fullCandidates
        .map((c: any) => ({ tag: c.tag, detail: c.detail ?? c.label ?? '', confidence: c.confidence ?? '', symbol: c.symbol, filePath: c.filePath }));
      // 損失候補 → R-BC 形式の検出パターン（LOSS_TAGS の絞り込みは generatePatterns 内）
      const { patterns, skipped } = generatePatterns(fullCandidates, preSurface.surface, postSurface.surface);
      patternRecords.push({ npm_pkg: pair.npm_pkg, prevVersion: pair.prevVersion, updatedVersion: pair.updatedVersion, patterns, skippedTags: skipped.map(s => s.tag) });
      // 判定に使った surface を pre/post ペアで保持（後で surface/<lib>/<prev>__<upd>.json に書く）
      surfacePairs.push({ npm_pkg: pair.npm_pkg, prevVersion: pair.prevVersion, updatedVersion: pair.updatedVersion, pre: preSurface.surface, post: postSurface.surface });
      // 依存 range 変化を signal として別枠で記録（採点は candidates のみ・depChanges は不使用）
      //TODO:実験用
      const depChanges = diffDeps(packument?.versions?.[pair.prevVersion], packument?.versions?.[pair.updatedVersion]);
      const bcLoss = candidates.length > 0 ? 'loss' : 'no-loss'; // candidates は LOSS_TAGS のみ＝候補ありがそのまま損失
      records.push({ ...pair, status: 'evaluated', reason: 'ok', analyzability: 'analyzed', bcLoss, candidates, depChanges });
    }
  }
  process.stderr.write('\n');

  const outputDir = path.resolve(process.cwd(), LIBRARY_DETECT_DIR);
  OutputJson.createOutputDirectory(outputDir);
  fs.writeFileSync(path.join(outputDir, 'records.json'), JSON.stringify(records, null, 2));

  const patternsDir = path.resolve(process.cwd(), PATTERNS_DIR);
  OutputJson.createOutputDirectory(patternsDir);
  fs.writeFileSync(path.join(patternsDir, 'patterns.json'), JSON.stringify(patternRecords, null, 2));

  // バージョンペア単位でも分割して出す（patterns.json は全体集約で手で確認しづらいため）
  //   patterns/by-lib/<lib>/<prev>__<upd>.json ＝ その遷移の PatternRecord 単体
  const byLibDir = path.join(patternsDir, 'by-lib');
  fs.rmSync(byLibDir, { recursive: true, force: true }); // 前回の残骸を残さない
  for (const r of patternRecords) {
    if (r.patterns.length === 0) continue; // 損失候補が無い遷移は書かない
    const libDir = path.join(byLibDir, toDirName(r.npm_pkg));
    OutputJson.createOutputDirectory(libDir);
    const vname = `${r.prevVersion}__${r.updatedVersion}`.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    fs.writeFileSync(path.join(libDir, `${vname}.json`), JSON.stringify(r, null, 2));
  }

  // 判定に使った surface を「判定する先（post 版）」ごとに残す（同一 run で同時に作った pre/post をその判定単位でまとめる）
  //   surface/<lib>/<postver>/{pre,post,diff}.json
  //     pre.json / post.json ＝ その版の完全な surface（後から再判定に使える）
  //     diff.json            ＝ pre/post で同じ symbol を削除した変化分のみ（変化点を素早く見る用）
  const surfaceDir = path.resolve(process.cwd(), SURFACE_DIR);
  fs.rmSync(surfaceDir, { recursive: true, force: true }); // 前回の残骸を残さない
  for (const s of surfacePairs) {
    const postName = s.updatedVersion.replace(/[^a-zA-Z0-9_.@-]/g, '_');
    const pairDir = path.join(surfaceDir, toDirName(s.npm_pkg), postName);
    OutputJson.createOutputDirectory(pairDir);
    const meta = { npm_pkg: s.npm_pkg, prevVersion: s.prevVersion, updatedVersion: s.updatedVersion };
    fs.writeFileSync(path.join(pairDir, 'pre.json'), JSON.stringify({ ...meta, surface: s.pre }, null, 2));
    fs.writeFileSync(path.join(pairDir, 'post.json'), JSON.stringify({ ...meta, surface: s.post }, null, 2));
    fs.writeFileSync(path.join(pairDir, 'diff.json'), JSON.stringify({ ...meta, ...diffSurfaceSymbols(s.pre, s.post) }, null, 2));
  }

  // .d.ts 妥当性検証を audit へ（型定義がある版だけを records に載せ、無い版は件数だけ）
  const auditDir = path.resolve(process.cwd(), AUDIT_DIR);
  OutputJson.createOutputDirectory(auditDir);
  const withDts = dtsRecords.filter(d => d.hasDts);
  const measured = withDts.filter(d => d.coverage !== undefined); // 値 export が1件以上ある版
  const declared = measured.reduce((n, d) => n + (d.dtsExportCount ?? 0), 0);
  const captured = measured.reduce((n, d) => n + (d.matchedCount ?? 0), 0);
  const dtsSummary = {
    versionsChecked: dtsRecords.length,
    withDts: withDts.length,
    withoutDts: dtsRecords.length - withDts.length, // 型定義の無い版（records に含めない）
    measured: measured.length,
    noValueExports: withDts.length - measured.length, // 型定義はあるが値 export が0件（coverage を付けない）
    avgCoverage: measured.length ? +(measured.reduce((n, d) => n + d.coverage!, 0) / measured.length).toFixed(3) : null,
    nameCoverage: { declared, captured, coverage: declared ? +(captured / declared).toFixed(3) : null }, // 名前単位（全版の合計）
    records: withDts,
  };
  fs.writeFileSync(path.join(auditDir, 'dts_coverage.json'), JSON.stringify(dtsSummary, null, 2));

  logger.flush(auditDir, 'runDetection'); // 監査ログは audit/ へ
  const evaluated = records.filter(r => r.status === 'evaluated').length;
  const totalPatterns = patternRecords.reduce((n, r) => n + r.patterns.length, 0);
  console.log(`[Done] records=${records.length} (evaluated=${evaluated}, excluded=${records.length - evaluated}) → ${outputDir}/records.json`);
  console.log(`[Done] patterns=${totalPatterns} (pairs=${patternRecords.length}) → ${patternsDir}/patterns.json`);
  console.log(`[Done] surface=${surfacePairs.length} pairs → ${surfaceDir}/<lib>/<postver>/{pre,post,diff}.json`);
  console.log(`[Done] dts: ${withDts.length}/${dtsRecords.length} 版に型定義あり (avgCoverage=${dtsSummary.avgCoverage}) → ${auditDir}/dts_coverage.json`);
}

// CLI 直接実行時のみ走らせる（import 時は走らせない）
if (process.argv[1] && /runDetection\.(ts|js)$/.test(process.argv[1])) {
  const maxLibs = process.argv[2] ? Number(process.argv[2]) : Infinity;
  initRunLog('detect');
  runDetection(maxLibs).catch(e => { logEvent('error', `[Fatal] ${e?.stack ?? e}`); console.error('[Fatal]', e); process.exit(1); });
}
