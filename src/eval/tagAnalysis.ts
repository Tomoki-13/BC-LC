import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import ApiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import LibRepo from '../libDiff/libRepo';

const GT_PATH = '../../outputs/latest/BC-LC/eval/ground_truth.json';
const CLONE_BASE = '../../clonedata/lib_versions';
const OUT_DIR = '../../outputs/latest/BC-LC/eval';

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

interface GT { npm_pkg: string; prevVersion: string; updatedVersion: string; loss: boolean; }

async function fetchFullDoc(lib: string): Promise<any | null> {
  try {
    const name = lib.startsWith('@') ? '@' + encodeURIComponent(lib.slice(1)) : encodeURIComponent(lib);
    const res = await fetch(`https://registry.npmjs.org/${name}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function resolveRef(repoDir: string, version: string, doc: any): string | null {
  return LibRepo.resolveRef(repoDir, version, doc?.versions?.[version]?.gitHead);
}

// タグ×クラスのカウンタ
type Tally = Record<string, { fail: number; succ: number }>;
function bump(t: Tally, key: string, loss: boolean) {
  if (!t[key]) t[key] = { fail: 0, succ: 0 };
  if (loss) t[key].fail++; else t[key].succ++;
}

async function main(): Promise<void> {
  const maxLibs = process.argv[2] ? Number(process.argv[2]) : Infinity;
  const gtPath = path.resolve(process.cwd(), GT_PATH);
  const gt = JSON.parse(fs.readFileSync(gtPath, 'utf-8')) as GT[];

  const byLib = new Map<string, GT[]>();
  for (const g of gt) { if (!byLib.has(g.npm_pkg)) byLib.set(g.npm_pkg, []); byLib.get(g.npm_pkg)!.push(g); }
  const libs = [...byLib.keys()].slice(0, maxLibs);

  // ペア単位で「出現タグ集合」を GT 別に数える
  const byTag: Tally = {};             // タグが1件でも出たペア数
  const byConf: Tally = {};            // confidence が出たペア数
  const soleTag: Tally = {};           // そのタグ「だけ」が出た（唯一の検出理由）ペア数
  let analyzable = 0, predLoss = 0;

  let idx = 0;
  for (const lib of libs) {
    idx++;
    const pairs = byLib.get(lib)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, safe(lib));
    process.stderr.write(`\r[${idx}/${libs.length}] ${lib}            `);
    if (!fs.existsSync(repoDir)) continue;
    const doc = await fetchFullDoc(lib);

    const surfCache = new Map<string, any | null>();
    const getSurface = async (ver: string): Promise<any | null> => {
      if (surfCache.has(ver)) return surfCache.get(ver)!;
      const ref = resolveRef(repoDir, ver, doc);
      if (!ref) { surfCache.set(ver, null); return null; }
      try { LibRepo.checkoutVersion(repoDir, ref); const s = await ApiSurface.buildApiSurface(repoDir, ver, ref); surfCache.set(ver, s); return s; }
      catch { surfCache.set(ver, null); return null; }
    };

    for (const p of pairs) {
      const pre = await getSurface(p.prevVersion);
      const post = await getSurface(p.updatedVersion);
      if (!pre || !post) continue;
      analyzable++;
      const cands = DiffSurface.diffSurface(pre, post, lib);
      if (cands.length === 0) continue;
      predLoss++;
      const tags = new Set(cands.map((c: any) => c.tag));
      const confs = new Set(cands.map((c: any) => c.confidence));
      for (const tg of tags) bump(byTag, tg as string, p.loss);
      for (const cf of confs) bump(byConf, cf as string, p.loss);
      if (tags.size === 1) bump(soleTag, [...tags][0] as string, p.loss);
    }
  }
  process.stderr.write('\n');

  const fmt = (t: Tally) => Object.entries(t)
    .map(([k, v]) => ({ key: k, fail: v.fail, succ: v.succ, total: v.fail + v.succ,
      failRate: +(v.fail / (v.fail + v.succ)).toFixed(3) }))
    .sort((a, b) => b.succ - a.succ);

  const summary = {
    analyzablePairs: analyzable,
    predictedLossPairs: predLoss,
    note: 'succ=そのタグが出た success(no-loss)ペア数=FP寄与。failRate 低いほどノイズ',
    byTag: fmt(byTag),
    byConfidence: fmt(byConf),
    soleReasonTag: fmt(soleTag),
  };

  const outDir = path.resolve(process.cwd(), OUT_DIR);
  fs.writeFileSync(path.join(outDir, 'tag_analysis.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[Done] ${outDir}/tag_analysis.json`);
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
