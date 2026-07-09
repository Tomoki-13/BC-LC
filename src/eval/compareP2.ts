import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import ApiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import LibRepo from '../libDiff/libRepo';
import { RunLogger } from '../utils/runLogger';
import { extractRepositoryUrl } from '../collectDataset/npm/registry';

// ground_truth(state) と P2(libDiff) の損失判定を比較し混同行列を出す
// 出力:
//   compare_summary.json … 評価可能ペアの混同行列＋除外内訳
//   evaluation.csv        … 実行できたペア（test_result / 損失有無 / 原因）
//   excluded_pairs.csv    … 実行できなかったペアと理由
//   compare_detail.csv    … 全ペアの素の判定（後方互換）
//   compareP2_run*.{log,json} … 監査

const GT_PATH = '../../outputs/latest/BC-LC/eval/ground_truth.json';
const CLONE_BASE = '../../clonedata/lib_versions';
const OUT_DIR = '../../outputs/latest/BC-LC/eval';

// npm パッケージ名をディレクトリ名に使える形へ（@scope/name → _scope_name）
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
// CSV 1セルのエスケープ（, " 改行 を含む値は RFC4180 準拠でクオート）
const csv = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// 正解1件（1つの版遷移。state=クライアントテスト結果 / loss = state==='failure'）
interface GT { npm_pkg: string; prevVersion: string; updatedVersion: string; state: 'success' | 'failure'; loss: boolean; }
// 版ごとの surface 取得結果（reason で「なぜ評価不能か」を表す）
interface SurfInfo { surface: any | null; reason: 'ok' | 'ref-unresolved' | 'build-error' | 'empty'; }

interface Row extends GT {
  status: 'evaluated' | 'excluded';
  reason: string;                 // excluded の理由 / evaluated は 'ok'
  predictedLoss: boolean | null;  // evaluated のみ true/false
  lossCount: number;
  tags: string;                   // 検出タグ 重複排除（; 区切り）
  causes: string;                 // 損失の原因（tag:detail を | 区切り）
  category: '' | 'TP' | 'FP' | 'FN' | 'TN';
}

/** npm レジストリから packument(全メタ) を取得。repository URL と各版 gitHead の供給元。失敗時 null */
async function fetchFullDoc(lib: string): Promise<any | null> {
  try {
    const name = lib.startsWith('@') ? '@' + encodeURIComponent(lib.slice(1)) : encodeURIComponent(lib);
    const res = await fetch(`https://registry.npmjs.org/${name}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** ground_truth 全ペアに P2 を実行し，各CSV/監査を出力 */
export async function runCompareP2(maxLibs: number = Infinity): Promise<void> {
  const logger = new RunLogger();

  const gtPath = path.resolve(process.cwd(), GT_PATH);
  if (!fs.existsSync(gtPath)) { console.error(`[Error] ${gtPath} が無い（先に eval/groundTruth.ts）`); process.exit(1); }
  const gt = JSON.parse(fs.readFileSync(gtPath, 'utf-8')) as GT[];

  const byLib = new Map<string, GT[]>();
  for (const g of gt) { if (!byLib.has(g.npm_pkg)) byLib.set(g.npm_pkg, []); byLib.get(g.npm_pkg)!.push(g); }
  const libs = [...byLib.keys()].slice(0, maxLibs);
  console.log(`[compareP2] libs=${libs.length} (全${byLib.size}), pairs=${libs.reduce((n, l) => n + byLib.get(l)!.length, 0)}`);

  const rows: Row[] = [];                         // 全ペアの評価/除外結果を蓄積
  // GT に空メタを足した Row の土台
  const base = (p: GT): Omit<Row, 'status' | 'reason' | 'predictedLoss' | 'category'> =>
    ({ ...p, lossCount: 0, tags: '', causes: '' });
  // 除外行（解析できなかったペア）を作る
  const excluded = (p: GT, reason: string): Row =>
    ({ ...base(p), status: 'excluded', reason, predictedLoss: null, category: '' });

  let libIdx = 0;
  for (const lib of libs) {
    libIdx++;
    const pairs = byLib.get(lib)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, safe(lib));
    process.stderr.write(`\r[${libIdx}/${libs.length}] ${lib} (${pairs.length} pairs)            `);

    const doc = await fetchFullDoc(lib);
    if (!doc) logger.warn(lib, '-', 'registry', 'npm registry doc 取得失敗（gitHead フォールバック不可）');
    if (!fs.existsSync(repoDir)) {
      const url = doc ? extractRepositoryUrl(doc?.versions?.[pairs[0].updatedVersion] ?? doc) : null;
      if (!url) {
        logger.error(lib, '-', 'clone', 'repository URL を特定できず（no-repo-url）');
        for (const p of pairs) rows.push(excluded(p, 'no-repo-url')); continue;
      }
      try { LibRepo.ensureClone(url, repoDir, process.env.GITHUB_TOKEN); }
      catch (e: any) {
        logger.error(lib, '-', 'clone', `clone 失敗: ${e?.message ?? e}`);
        for (const p of pairs) rows.push(excluded(p, 'clone-failed')); continue;
      }
    }

    // 版ごとに surface を1回だけ抽出してキャッシュ（reason 付き）
    const cache = new Map<string, SurfInfo>();
    const getSurface = async (ver: string): Promise<SurfInfo> => {
      const hit = cache.get(ver); if (hit) return hit;
      const { ref, method } = LibRepo.resolveRefDetailed(repoDir, ver, doc?.versions?.[ver]?.gitHead);
      logger.resolution(lib, ver, method, ref);
      let info: SurfInfo;
      if (!ref) {
        logger.error(lib, ver, 'resolve', 'tag/package.json/gitHead/commit-message いずれでも切り替えるcommitを特定できず');
        info = { surface: null, reason: 'ref-unresolved' };
      } else {
        if (method === 'git-head' || method === 'commit-message') logger.warn(lib, ver, 'resolve', `低信頼な手段で解決(${method}) ref=${ref.slice(0, 12)}（要目視確認）`);
        try {
          LibRepo.checkoutVersion(repoDir, ref);
          const s = await ApiSurface.buildApiSurface(repoDir, ver, ref);
          if (s.symbols.length === 0) { logger.warn(lib, ver, 'surface', `export 関数が0件（抽出漏れ/ビルド成果物未コミット等）ref=${ref.slice(0, 12)}`); info = { surface: s, reason: 'empty' }; }
          else info = { surface: s, reason: 'ok' };
        } catch (e: any) {
          logger.error(lib, ver, 'surface', `checkout/解析 失敗: ${e?.message ?? e}`);
          info = { surface: null, reason: 'build-error' };
        }
      }
      cache.set(ver, info); return info;
    };

    for (const p of pairs) {
      const pre = await getSurface(p.prevVersion);
      const post = await getSurface(p.updatedVersion);
      // どちらかの版が評価不能なら除外（どの版が何の理由かを記録）
      if (pre.reason !== 'ok' || post.reason !== 'ok') {
        const parts: string[] = [];
        if (pre.reason !== 'ok') parts.push(`pre(${p.prevVersion}):${pre.reason}`);
        if (post.reason !== 'ok') parts.push(`post(${p.updatedVersion}):${post.reason}`);
        rows.push(excluded(p, parts.join(' / '))); continue;
      }
      const cands = DiffSurface.diffSurface(pre.surface, post.surface, lib);
      const predicted = cands.length > 0;
      const category: Row['category'] = p.loss ? (predicted ? 'TP' : 'FN') : (predicted ? 'FP' : 'TN');
      const tags = [...new Set(cands.map((c: any) => c.tag))].join(';');
      const causes = cands.map((c: any) => `${c.tag}:${c.detail ?? c.label}`).join(' | ');
      rows.push({ ...base(p), status: 'evaluated', reason: 'ok', predictedLoss: predicted, lossCount: cands.length, tags, causes, category });
    }
  }
  process.stderr.write('\n');

  // 集計（評価可能ペアのみで混同行列）
  const evaluated = rows.filter(r => r.status === 'evaluated');
  const excludedRows = rows.filter(r => r.status === 'excluded');
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of evaluated) { if (r.category === 'TP') m.tp++; else if (r.category === 'FP') m.fp++; else if (r.category === 'FN') m.fn++; else m.tn++; }
  const prec = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0;
  const rec = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
  const acc = evaluated.length ? (m.tp + m.tn) / evaluated.length : 0;
  const f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;

  const excludedByReason: Record<string, number> = {};
  for (const r of excludedRows) { const key = r.reason.replace(/\([^)]*\)/g, ''); excludedByReason[key] = (excludedByReason[key] ?? 0) + 1; }

  const summary = {
    totalPairs: rows.length,
    evaluated: evaluated.length,
    excluded: excludedRows.length,
    excludedByReason,
    groundTruth: { failure_loss: evaluated.filter(r => r.loss).length, success_noLoss: evaluated.filter(r => !r.loss).length },
    confusion: m,
    metrics: { precision: +prec.toFixed(4), recall: +rec.toFixed(4), accuracy: +acc.toFixed(4), f1: +f1.toFixed(4) },
  };

  const outDir = path.resolve(process.cwd(), OUT_DIR);
  OutputJson.createOutputDirectory(outDir);
  fs.writeFileSync(path.join(outDir, 'compare_summary.json'), JSON.stringify(summary, null, 2));

  // 評価用 CSV（実行できたペア: test_result / 本手法の損失有無 / 原因）
  const evalHeader = 'npm_pkg,prevVersion,updatedVersion,test_result,predicted_loss,category,loss_count,tags,causes\n';
  fs.writeFileSync(path.join(outDir, 'evaluation.csv'), evalHeader + evaluated.map(r =>
    [r.npm_pkg, r.prevVersion, r.updatedVersion, r.state, r.predictedLoss ? 'yes' : 'no', r.category, r.lossCount, r.tags, r.causes].map(csv).join(',')
  ).join('\n'));

  // 除外 CSV（実行できなかったペアと理由）
  const exHeader = 'npm_pkg,prevVersion,updatedVersion,test_result,reason\n';
  fs.writeFileSync(path.join(outDir, 'excluded_pairs.csv'), exHeader + excludedRows.map(r =>
    [r.npm_pkg, r.prevVersion, r.updatedVersion, r.state, r.reason].map(csv).join(',')
  ).join('\n'));

  // 損失タグ(=Positive と判定した理由)の分布。ペア単位・タグ重複排除（1ペアで同タグ複数でも1）
  const tagStat: Record<string, { tp: number; fp: number }> = {};
  for (const r of evaluated) {
    if (r.category !== 'TP' && r.category !== 'FP') continue;
    for (const tag of r.tags.split(';').filter(Boolean)) {
      (tagStat[tag] ??= { tp: 0, fp: 0 })[r.category === 'TP' ? 'tp' : 'fp']++;
    }
  }
  const distRows = Object.entries(tagStat)
    .map(([tag, s]) => ({ tag, tp: s.tp, fp: s.fp, total: s.tp + s.fp, precision: +(s.tp / (s.tp + s.fp)).toFixed(3) }))
    .sort((a, b) => b.total - a.total);
  fs.writeFileSync(path.join(outDir, 'label_distribution.csv'), 'tag,TP,FP,total,precision\n' +
    distRows.map(d => [d.tag, d.tp, d.fp, d.total, d.precision].join(',')).join('\n'));

  // 素の判定（後方互換）
  const detHeader = 'npm_pkg,prevVersion,updatedVersion,groundTruthLoss,predictedLoss,lossCount,status,reason\n';
  fs.writeFileSync(path.join(outDir, 'compare_detail.csv'), detHeader + rows.map(r =>
    [r.npm_pkg, r.prevVersion, r.updatedVersion, r.loss, r.predictedLoss, r.lossCount, r.status, r.reason].map(csv).join(',')
  ).join('\n'));

  logger.flush(outDir, 'compareP2');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[Done] ${outDir}/{compare_summary.json, evaluation.csv, excluded_pairs.csv, label_distribution.csv, compare_detail.csv}`);
}

// CLI 直接実行時のみ走らせる（import 時は走らせない）
if (process.argv[1] && /compareP2\.(ts|js)$/.test(process.argv[1])) {
  const n = process.argv[2] ? Number(process.argv[2]) : Infinity;
  runCompareP2(n).catch(e => { console.error('[Fatal]', e); process.exit(1); });
}
