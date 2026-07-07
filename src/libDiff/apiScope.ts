import fs from 'fs';
import path from 'path';
import type { ApiSurface } from '../types/LibDiff';
// mode 0 = 絞り込みなし / 1 = test ファイル由来 / 2 = README 由来
export type ScopeMode = 0 | 1 | 2;

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const TEST_DIR = new Set(['__tests__', 'test', 'tests', 'spec', 'specs']);
const isTestFile = (f: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.split(path.sep).some(seg => TEST_DIR.has(seg));

/** dir 配下を再帰列挙（node_modules と .git は除外） */
function walk(dir: string, out: string[] = []): string[] {
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** テストファイル中に識別子として現れる名前集合（外部 API 候補の推定に使う） */
export function collectTestNames(repoDir: string): Set<string> {
  const names = new Set<string>();
  for (const f of walk(repoDir)) {
    if (!isTestFile(f) || !/\.[cm]?[jt]sx?$/.test(f)) continue;
    let src: string; try { src = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    for (const m of src.matchAll(IDENT_RE)) names.add(m[0]);
  }
  return names;
}

/** README 中に現れる名前集合（コード span/fence を含む本文全体の識別子） */
export function collectReadmeNames(repoDir: string): Set<string> {
  const names = new Set<string>();
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(repoDir, { withFileTypes: true }); } catch { return names; }
  for (const e of ents) {
    if (!e.isFile() || !/^readme/i.test(e.name)) continue;
    let src: string; try { src = fs.readFileSync(path.join(repoDir, e.name), 'utf-8'); } catch { continue; }
    for (const m of src.matchAll(IDENT_RE)) names.add(m[0]);
  }
  return names;
}

/** surface のシンボルを名前集合で絞る（mode0 は無変換） */
export function filterSurface(surface: ApiSurface, mode: ScopeMode, names: Set<string>): ApiSurface {
  if (mode === 0) return surface;
  return { ...surface, symbols: surface.symbols.filter(s => names.has(s.name)) };
}
