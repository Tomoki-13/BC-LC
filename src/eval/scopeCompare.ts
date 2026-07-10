import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import ApiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import LibRepo from '../libDiff/libRepo';
import ApiScope from '../libDiff/apiScope';
import type { ScopeMode, ApiUsage } from '../types/LibDiff';
import { extractRepositoryUrl } from '../collectDataset/npm/registry';

const GT_PATH = '../../outputs/latest/BC-LC/eval/ground_truth.json';
const CLONE_BASE = '../../clonedata/lib_versions';
const OUT_DIR = '../../outputs/latest/BC-LC/eval';
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
const MODES: ScopeMode[] = [0, 1, 2, 3];
const emptyUsage = (): ApiUsage => ({ named: new Set(), defaultUsed: false, deepPaths: new Set() });

interface GT { npm_pkg: string; prevVersion: string; updatedVersion: string; loss: boolean; }
interface VerData { surface: any; test: ApiUsage; readme: ApiUsage; allMd: ApiUsage; }

async function fetchFullDoc(lib: string): Promise<any | null> {
  try {
    const name = lib.startsWith('@') ? '@' + encodeURIComponent(lib.slice(1)) : encodeURIComponent(lib);
    const res = await fetch(`https://registry.npmjs.org/${name}`); if (!res.ok) return null; return await res.json();
  } catch { return null; }
}

function metrics(m: { tp: number; fp: number; fn: number; tn: number }) {
  const prec = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0;
  const rec = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
  const f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
  return { precision: +prec.toFixed(3), recall: +rec.toFixed(3), f1: +f1.toFixed(3) };
}

const usageForMode = (v: VerData, mode: ScopeMode): ApiUsage =>
  mode === 1 ? v.test : mode === 2 ? v.readme : mode === 3 ? v.allMd : emptyUsage();

async function main(): Promise<void> {
  const maxLibs = process.argv[2] ? Number(process.argv[2]) : Infinity;
  const gt = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), GT_PATH), 'utf-8')) as GT[];
  const byLib = new Map<string, GT[]>();
  for (const g of gt) { if (!byLib.has(g.npm_pkg)) byLib.set(g.npm_pkg, []); byLib.get(g.npm_pkg)!.push(g); }
  const libs = [...byLib.keys()].slice(0, maxLibs);

  const conf: Record<ScopeMode, { tp: number; fp: number; fn: number; tn: number }> =
    { 0: { tp: 0, fp: 0, fn: 0, tn: 0 }, 1: { tp: 0, fp: 0, fn: 0, tn: 0 }, 2: { tp: 0, fp: 0, fn: 0, tn: 0 }, 3: { tp: 0, fp: 0, fn: 0, tn: 0 } };
  let analyzable = 0, unavailable = 0;

  let idx = 0;
  for (const lib of libs) {
    idx++;
    const pairs = byLib.get(lib)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, safe(lib));
    process.stderr.write(`\r[${idx}/${libs.length}] ${lib}            `);
    const doc = await fetchFullDoc(lib);
    if (!fs.existsSync(repoDir)) {
      const url = doc ? extractRepositoryUrl(doc?.versions?.[pairs[0].updatedVersion] ?? doc) : null;
      if (!url) { unavailable += pairs.length; continue; }
      try { LibRepo.ensureClone(url, repoDir, process.env.GITHUB_TOKEN); }
      catch { unavailable += pairs.length; continue; }
    }

    const cache = new Map<string, VerData | null>();
    const getVer = async (ver: string): Promise<VerData | null> => {
      if (cache.has(ver)) return cache.get(ver)!;
      const ref = LibRepo.resolveRef(repoDir, ver, doc?.versions?.[ver]?.gitHead);
      if (!ref) { cache.set(ver, null); return null; }
      try {
        LibRepo.checkoutVersion(repoDir, ref);
        const surface = await ApiSurface.buildApiSurface(repoDir, ver, ref);
        const data: VerData = {
          surface,
          test: ApiScope.collectTestUsage(repoDir, lib),
          readme: ApiScope.collectMarkdownUsage(repoDir, lib, true),
          allMd: ApiScope.collectMarkdownUsage(repoDir, lib, false),
        };
        cache.set(ver, data); return data;
      } catch { cache.set(ver, null); return null; }
    };

    for (const p of pairs) {
      const pre = await getVer(p.prevVersion); const post = await getVer(p.updatedVersion);
      if (!pre || !post) { unavailable++; continue; }
      analyzable++;
      for (const mode of MODES) {
        const sp = ApiScope.filterSurface(pre.surface, mode, usageForMode(pre, mode));
        const sq = ApiScope.filterSurface(post.surface, mode, usageForMode(post, mode));
        const pred = DiffSurface.diffSurface(sp, sq, lib).length > 0;
        const c = conf[mode];
        if (p.loss && pred) c.tp++; else if (p.loss && !pred) c.fn++; else if (!p.loss && pred) c.fp++; else c.tn++;
      }
    }
  }
  process.stderr.write('\n');

  const label: Record<ScopeMode, string> = { 0: '0 全export', 1: '1 test由来', 2: '2 README由来', 3: '3 全md由来' };
  const rows = MODES.map(mode => ({ mode: label[mode], ...conf[mode], ...metrics(conf[mode]) }));
  const summary = { analyzable, unavailable, modes: rows };
  const outDir = path.resolve(process.cwd(), OUT_DIR);
  OutputJson.createOutputDirectory(outDir);
  fs.writeFileSync(path.join(outDir, 'scope_compare.json'), JSON.stringify(summary, null, 2));
  console.log(`analyzable=${analyzable} unavailable=${unavailable}`);
  console.table(rows);
  console.log(`[Done] ${outDir}/scope_compare.json`);
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
