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
const DUMP = path.resolve(process.cwd(), OUT_DIR, 'pair_tags.json');

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

interface GT { npm_pkg: string; prevVersion: string; updatedVersion: string; loss: boolean; }
interface Rec { lib: string; pre: string; post: string; loss: boolean; tags: string[]; confs: string[]; }

async function fetchFullDoc(lib: string): Promise<any | null> {
  try {
    const name = lib.startsWith('@') ? '@' + encodeURIComponent(lib.slice(1)) : encodeURIComponent(lib);
    const res = await fetch(`https://registry.npmjs.org/${name}`); if (!res.ok) return null; return await res.json();
  } catch { return null; }
}
function resolveRef(repoDir: string, version: string, doc: any): string | null {
  return LibRepo.resolveRef(repoDir, version, doc?.versions?.[version]?.gitHead);
}

async function buildDump(maxLibs: number): Promise<Rec[]> {
  const gt = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), GT_PATH), 'utf-8')) as GT[];
  const byLib = new Map<string, GT[]>();
  for (const g of gt) { if (!byLib.has(g.npm_pkg)) byLib.set(g.npm_pkg, []); byLib.get(g.npm_pkg)!.push(g); }
  const libs = [...byLib.keys()].slice(0, maxLibs);
  const recs: Rec[] = [];
  let idx = 0;
  for (const lib of libs) {
    idx++;
    const pairs = byLib.get(lib)!;
    const repoDir = path.resolve(process.cwd(), CLONE_BASE, safe(lib));
    process.stderr.write(`\r[${idx}/${libs.length}] ${lib}            `);
    if (!fs.existsSync(repoDir)) continue;
    const doc = await fetchFullDoc(lib);
    const cache = new Map<string, any | null>();
    const getS = async (v: string) => {
      if (cache.has(v)) return cache.get(v)!;
      const ref = resolveRef(repoDir, v, doc); if (!ref) { cache.set(v, null); return null; }
      try { LibRepo.checkoutVersion(repoDir, ref); const s = await ApiSurface.buildApiSurface(repoDir, v, ref); cache.set(v, s); return s; }
      catch { cache.set(v, null); return null; }
    };
    for (const p of pairs) {
      const pre = await getS(p.prevVersion); const post = await getS(p.updatedVersion);
      if (!pre || !post) continue;
      const cands = DiffSurface.diffSurface(pre, post, lib);
      recs.push({ lib, pre: p.prevVersion, post: p.updatedVersion, loss: p.loss,
        tags: [...new Set(cands.map((c: any) => c.tag))], confs: [...new Set(cands.map((c: any) => c.confidence))] });
    }
  }
  process.stderr.write('\n');
  fs.writeFileSync(DUMP, JSON.stringify(recs));
  return recs;
}

function evalPolicy(recs: Rec[], name: string, isLoss: (r: Rec) => boolean) {
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of recs) {
    const pred = isLoss(r);
    if (r.loss && pred) m.tp++; else if (r.loss && !pred) m.fn++; else if (!r.loss && pred) m.fp++; else m.tn++;
  }
  const prec = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 0;
  const rec = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 0;
  const f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
  const acc = recs.length ? (m.tp + m.tn) / recs.length : 0;
  return { name, ...m, precision: +prec.toFixed(3), recall: +rec.toFixed(3), f1: +f1.toFixed(3), accuracy: +acc.toFixed(3) };
}

async function main() {
  const args = process.argv.slice(2);
  const reuse = args.includes('--reuse');
  const maxLibs = args.find(a => /^\d+$/.test(a)) ? Number(args.find(a => /^\d+$/.test(a))) : Infinity;

  let recs: Rec[];
  if (reuse && fs.existsSync(DUMP)) recs = JSON.parse(fs.readFileSync(DUMP, 'utf-8'));
  else recs = await buildDump(maxLibs);

  const has = (r: Rec, t: string) => r.tags.includes(t);
  const hasAny = (r: Rec, ts: string[]) => r.tags.some(t => ts.includes(t));
  const NOISE = ['return-changed', 'export-style-changed'];
  // P0 現行(候補≥1) / P1 structural のみ / P2 return-changed 除外 / P3 return+export-style 除外 / P4 structural OR (return-changed 単独でない) / P5 function-removed + arg系のみ
  const policies = [
    evalPolicy(recs, 'P0 現行(候補≥1)', r => r.tags.length > 0),
    evalPolicy(recs, 'P1 structural のみ', r => r.confs.includes('structural')),
    evalPolicy(recs, 'P2 return-changed 除外', r => r.tags.filter(t => t !== 'return-changed').length > 0),
    evalPolicy(recs, 'P3 return+export-style 除外', r => r.tags.filter(t => !NOISE.includes(t)).length > 0),
    evalPolicy(recs, 'P4 structural OR (return-changed 単独でない)', r =>
      r.confs.includes('structural') || (has(r, 'return-changed') && r.tags.length > 1)),
    evalPolicy(recs, 'P5 function-removed + arg系のみ', r =>
      hasAny(r, ['function-removed', 'arg-added', 'arg-removed', 'arg-reordered'])),
  ];

  console.log(`analyzable=${recs.length}  GT_fail=${recs.filter(r => r.loss).length}  GT_succ=${recs.filter(r => !r.loss).length}`);
  console.table(policies);
  fs.writeFileSync(path.resolve(process.cwd(), OUT_DIR, 'policy_sweep.json'), JSON.stringify(policies, null, 2));
  console.log(`[Done] pair_tags.json / policy_sweep.json`);
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
