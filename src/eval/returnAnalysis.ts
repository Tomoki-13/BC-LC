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
  try { const name = lib.startsWith('@') ? '@' + encodeURIComponent(lib.slice(1)) : encodeURIComponent(lib);
    const res = await fetch(`https://registry.npmjs.org/${name}`); if (!res.ok) return null; return await res.json(); } catch { return null; }
}
function resolveRef(repoDir: string, version: string, doc: any): string | null {
  return LibRepo.resolveRef(repoDir, version, doc?.versions?.[version]?.gitHead);
}
// detail: "return: [ra] → [rb]" から ra/rb を復元
function parseDetail(d: string): { ra: string; rb: string } | null {
  const m = d.match(/^return: \[([\s\S]*)\] → \[([\s\S]*)\]$/);
  return m ? { ra: m[1], rb: m[2] } : null;
}
const segs = (s: string) => s.trim() === '' ? 0 : s.split('||').length;

async function main() {
  const maxLibs = process.argv[2] ? Number(process.argv[2]) : Infinity;
  const gt = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), GT_PATH), 'utf-8')) as GT[];
  const byLib = new Map<string, GT[]>();
  for (const g of gt) { if (!byLib.has(g.npm_pkg)) byLib.set(g.npm_pkg, []); byLib.get(g.npm_pkg)!.push(g); }
  const libs = [...byLib.keys()].slice(0, maxLibs);

  // 分類キー → {fail,succ}
  const cat: Record<string, { fail: number; succ: number }> = {};
  const bump = (k: string, loss: boolean) => { (cat[k] ??= { fail: 0, succ: 0 })[loss ? 'fail' : 'succ']++; };

  let idx = 0;
  for (const lib of libs) {
    idx++;
    const pairs = byLib.get(lib)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, safe(lib));
    process.stderr.write(`\r[${idx}/${libs.length}] ${lib}            `);
    if (!fs.existsSync(repoDir)) continue;
    const doc = await fetchFullDoc(lib);
    const cache = new Map<string, any | null>();
    const getS = async (v: string) => { if (cache.has(v)) return cache.get(v)!;
      const ref = resolveRef(repoDir, v, doc); if (!ref) { cache.set(v, null); return null; }
      try { LibRepo.checkoutVersion(repoDir, ref); const s = await ApiSurface.buildApiSurface(repoDir, v, ref); cache.set(v, s); return s; } catch { cache.set(v, null); return null; } };

    for (const p of pairs) {
      const pre = await getS(p.prevVersion); const post = await getS(p.updatedVersion);
      if (!pre || !post) continue;
      const cands = DiffSurface.diffSurface(pre, post, lib).filter((c: any) => c.tag === 'return-changed');
      if (cands.length === 0) continue;
      // ペア単位で最も強い兆候を1つ選ぶ
      let key = 'text-only';
      for (const c of cands) {
        const pd = parseDetail(c.detail ?? ''); if (!pd) continue;
        const na = segs(pd.ra), nb = segs(pd.rb);
        if (nb === 0 && na > 0) { key = 'return-dropped(post空)'; break; }
        if (na === 0 && nb > 0) { key = 'return-added(pre空)'; }
        else if (nb < na) { if (key === 'text-only') key = 'seg-decreased'; }
        else if (nb > na) { if (key === 'text-only') key = 'seg-increased'; }
      }
      bump(key, p.loss);
    }
  }
  process.stderr.write('\n');

  const rows = Object.entries(cat).map(([k, v]) => ({ key: k, fail: v.fail, succ: v.succ,
    total: v.fail + v.succ, failRate: +(v.fail / (v.fail + v.succ)).toFixed(3) })).sort((a, b) => b.total - a.total);
  console.log('=== return-changed ペアの兆候別 内訳（fail=TP寄与, succ=FP寄与）===');
  console.table(rows);
  fs.writeFileSync(path.resolve(process.cwd(), OUT_DIR, 'return_analysis.json'), JSON.stringify(rows, null, 2));
}
main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
