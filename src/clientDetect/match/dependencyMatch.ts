import fs from 'fs';
import path from 'path';
import semver from 'semver';

import { REGISTRY_DEPS_CACHE } from '../../utils/evalShared';

// ソースに直接の import が無いクライアントが、依存を辿って対象ライブラリに届くかを判定する（間接依存・設定ファイル経由の利用）
//   1) package.json の依存に記載（設定ファイル・CLI・lazy-cache など、import 文以外で使う）
//   2) ロックファイル（yarn.lock / pnpm-lock.yaml / npm-shrinkwrap.json / package-lock.json）に記載
//   3) npm registry の依存情報で、依存の依存を2段まで辿る（range を満たす最新版の dependencies・ロックファイルが無いときの近似）
//   3) は環境変数 BCLC_DEP_REGISTRY=0 で切れる。応答は依存情報だけにして REGISTRY_DEPS_CACHE にキャッシュする

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const LOCKFILES = ['yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'package-lock.json'];
const REGISTRY_CONCURRENCY = 16;

type VersionDeps = Record<string, Record<string, string>>; // version → dependencies
const metaMemo = new Map<string, Promise<VersionDeps | null>>();
const resultMemo = new Map<string, Promise<string | null>>();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readPackageJson(repoDir: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** ロックファイルに lib の項目があるか。あればファイル名 */
function lockfileWith(repoDir: string, lib: string): string | null {
  const name = escapeRe(lib);
  // yarn: `lib@^1.0.0:` / `"lib@^1.0.0":`、pnpm: `/lib/1.0.0:` / `lib@1.0.0`、npm: `"node_modules/lib"` / `"lib": {`
  const re = new RegExp(`(^|[\\s"'/])${name}(@|/\\d)|"node_modules/${name}"|"${name}": \\{`, 'm');
  for (const f of LOCKFILES) {
    try {
      if (re.test(fs.readFileSync(path.join(repoDir, f), 'utf-8'))) return f;
    } catch { /* そのロックファイルは無い */ }
  }
  return null;
}

/** registry の依存情報（版 → dependencies）。キャッシュ優先・取れなければ null */
function registryDeps(name: string): Promise<VersionDeps | null> {
  const memo = metaMemo.get(name);
  if (memo) return memo;
  const p = (async () => {
    const cacheDir = path.resolve(process.cwd(), REGISTRY_DEPS_CACHE);
    const file = path.join(cacheDir, `${encodeURIComponent(name)}.json`);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as VersionDeps | null;
    } catch { /* キャッシュなし */ }
    let data: VersionDeps | null = null;
    try {
      const urlName = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
      const res = await fetch(`https://registry.npmjs.org/${urlName}`, { headers: { Accept: 'application/vnd.npm.install-v1+json' } });
      if (res.ok) {
        const json: any = await res.json();
        data = Object.fromEntries(Object.entries(json.versions ?? {}).map(([v, m]: [string, any]) => [v, m.dependencies ?? {}]));
      }
    } catch {
      return null; // 通信失敗はキャッシュしない（次回に再取得）
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  })();
  metaMemo.set(name, p);
  return p;
}

/** range を満たす最新版の dependencies（解決できなければ null） */
async function depsOf(name: string, range: string): Promise<Record<string, string> | null> {
  const meta = await registryDeps(name);
  if (!meta) return null;
  let version: string | null = null;
  try {
    version = semver.maxSatisfying(Object.keys(meta), range);
  } catch {
    version = null;
  }
  return version ? meta[version] : null;
}

/** 依存を並列（上限つき）に解決する */
async function resolveAll(entries: [string, string][]): Promise<{ name: string; deps: Record<string, string> }[]> {
  const out: { name: string; deps: Record<string, string> }[] = [];
  for (let i = 0; i < entries.length; i += REGISTRY_CONCURRENCY) {
    const chunk = entries.slice(i, i + REGISTRY_CONCURRENCY);
    const resolved = await Promise.all(chunk.map(async ([n, r]) => ({ name: n, deps: await depsOf(n, r) })));
    for (const r of resolved) if (r.deps) out.push({ name: r.name, deps: r.deps });
  }
  return out;
}

async function findPath(repoDir: string, lib: string): Promise<string | null> {
  const pkg = readPackageJson(repoDir);
  const declared = DEP_FIELDS.find(f => pkg?.[f]?.[lib] !== undefined);
  if (declared) return `package.json:${declared}`;
  const lock = lockfileWith(repoDir, lib);
  if (lock) return `lockfile:${lock}`;
  if (!pkg || process.env.BCLC_DEP_REGISTRY === '0') return null;

  const top = Object.entries({ ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) })
    .filter(([, r]) => typeof r === 'string') as [string, string][];
  const level1 = await resolveAll(top);
  const hit1 = level1.find(d => d.deps[lib] !== undefined);
  if (hit1) return `registry:${hit1.name}`;
  for (const d of level1) {
    const level2 = await resolveAll(Object.entries(d.deps));
    const hit2 = level2.find(x => x.deps[lib] !== undefined);
    if (hit2) return `registry:${d.name}>${hit2.name}`;
  }
  return null;
}

/**
 * クライアント repo が依存を辿って lib に届くなら経路（例 'package.json:devDependencies' / 'lockfile:yarn.lock' / 'registry:del>globby'）、
 * 届かなければ null。同じ repo×lib は1回だけ調べる
 */
export function dependencyPath(repoDir: string, lib: string): Promise<string | null> {
  const key = `${repoDir}::${lib}`;
  let p = resultMemo.get(key);
  if (!p) {
    p = findPath(repoDir, lib);
    resultMemo.set(key, p);
  }
  return p;
}
