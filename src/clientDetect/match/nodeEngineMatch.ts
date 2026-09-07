import fs from 'fs';
import path from 'path';
import semver from 'semver';
import type { EnvPredicate } from '../../types/patternTypes';

// 環境述語(node-engine)の照合。コマンド実行なしで client repo の静的ファイルから使用 Node 版を判定
// 優先順: CI（実テスト版・GT と整合）→ 宣言（engines.node 等）-> 数値化できた版の最小 < requiredMin なら壊れる
// 読む環境ファイル:
//   CI  : .travis.yml(.yaml) の node_js / .github/workflows/*.yml の node-version / appveyor.yml の nodejs_version
//   宣言: package.json の engines.node(最小)・volta.node / .nvmrc / .node-version
const read = (p: string): string => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
const exists = (p: string): boolean => { try { return fs.existsSync(p); } catch { return false; } };

// "10" / "8.9" / "v10" / "0.10.0" → semver。"lts/*" / "node" / "stable" / 変数参照 → null
function coerceVersion(token: string): string | null {
  const t = token.trim().replace(/^['"]|['"]$/g, '');
  if (!t || /[a-z*${}]/i.test(t.replace(/^v/i, ''))) return null; // 記号値・matrix 参照は数値化不能
  return semver.coerce(t)?.version ?? null;
}

// 文字列中の "- X" リスト項目 or インライン配列から数値版を集める
function collectListVersions(block: string): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(/-\s*([^\n#]+)/g)) { const v = coerceVersion(m[1]); if (v) out.push(v); }
  for (const m of block.matchAll(/\[([^\]]*)\]/g)) for (const tok of m[1].split(',')) { const v = coerceVersion(tok); if (v) out.push(v); }
  return out;
}

// node_js: / node-version: / nodejs_version: のブロック（同行インライン＋続く list 行）を切り出す
function versionsForKey(text: string, key: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`(^|\\s)${key}\\s*:(.*)$`));
    if (!m) continue;
    const inline = m[2].trim();
    if (inline && !inline.startsWith('#')) { // インライン値（'10' / [6,8] / ${{...}}）
      const arr = collectListVersions(inline); if (arr.length) out.push(...arr);
      else { const v = coerceVersion(inline); if (v) out.push(v); }
    }
    // 続くインデントされた list 行を読む
    const baseIndent = lines[i].search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      const indent = lines[j].search(/\S/);
      if (lines[j].trim() === '') continue;
      if (indent <= baseIndent && !/^\s*-/.test(lines[j])) break;
      const lm = lines[j].match(/-\s*([^\n#]+)/); if (lm) { const v = coerceVersion(lm[1]); if (v) out.push(v); }
    }
  }
  return out;
}

/** CI 設定から実テスト Node 版を集める（travis / GitHub Actions / appveyor） */
function ciVersions(repoDir: string): string[] {
  const out: string[] = [];
  for (const f of ['.travis.yml', '.travis.yaml']) if (exists(path.join(repoDir, f))) out.push(...versionsForKey(read(path.join(repoDir, f)), 'node_js'));
  const gh = path.join(repoDir, '.github', 'workflows');
  if (exists(gh)) { try { for (const f of fs.readdirSync(gh)) if (/\.ya?ml$/.test(f)) out.push(...versionsForKey(read(path.join(gh, f)), 'node-version')); } catch { /* skip */ } }
  for (const f of ['appveyor.yml', '.appveyor.yml']) if (exists(path.join(repoDir, f))) out.push(...versionsForKey(read(path.join(repoDir, f)), 'nodejs_version'));
  return out;
}

/** 宣言系から Node 版を集める（engines.node 下限 / .nvmrc / .node-version / volta） */
function declaredVersions(repoDir: string): string[] {
  const out: string[] = [];
  const pj = path.join(repoDir, 'package.json');
  if (exists(pj)) { 
    try { 
      const j = JSON.parse(read(pj)); const min = j.engines?.node ? semver.minVersion(j.engines.node)?.version : null; if (min) out.push(min); const v = j.volta?.node ? coerceVersion(j.volta.node) : null; if (v) out.push(v); 
    } catch { /* skip */ } }
  for (const f of ['.nvmrc', '.node-version']) if (exists(path.join(repoDir, f))) { const v = coerceVersion(read(path.join(repoDir, f)).split('\n')[0] ?? ''); if (v) out.push(v); }
  return out;
}

/** client の使用 Node 版の最小を静的に判定（CI 優先・数値化できなければ null＝unknown） */
export function clientNodeMin(repoDir: string): { min: string; source: 'ci' | 'declared' } | null {
  const ci = ciVersions(repoDir);
  if (ci.length) return { min: ci.sort(semver.compare)[0], source: 'ci' };
  const dec = declaredVersions(repoDir);
  if (dec.length) return { min: dec.sort(semver.compare)[0], source: 'declared' };
  return null; // 判別材料なし＝検出しない
}

/** 環境述語がこの client に命中するか（使用 Node 版の最小 < requiredMin）。判別不能なら false */
export function nodeEngineHits(env: EnvPredicate, repoDir: string): boolean {
  const found = clientNodeMin(repoDir);
  if (!found) return false;
  return semver.lt(found.min, env.requiredMin);
}
