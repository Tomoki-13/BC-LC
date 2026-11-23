import '../utils/loadEnv';
import fs from 'fs';
import path from 'path';
import semver from 'semver';

import LibRepo from '../libDiff/libRepo';
import { diffDeps } from '../depImpact/depDiff';
import { extractRepositoryUrl } from '../utils/npmRegistry';
import { DEPENDENCY_CLONE_BASE, fetchPackument, toDirName, toCsvCell } from '../utils/evalShared';
import { initRunLog, phase, progress, logEvent, runLogSummary } from '../utils/runLog';

// 依存パッケージのクローンを clonedata/dependency_versions/<パッケージ>/ に用意する（分析対象の lib_versions とは分ける）
//   対象: datasets/proposal_result.json のバージョンペアで dependencies の範囲が変わった（major・minor/patch）依存パッケージ
//   調べるバージョン（範囲の下限）の repository を <パッケージ>/<owner>__<repo>/ に全タグ・全履歴で clone する（バージョンは損失判定のときに git archive で取り出す）。既にあれば何もしない
//   出力: <ログ先>/dependency_clone_summary.csv（パッケージごとの結果）
const PROPOSAL = '../../datasets/proposal_result.json';

type CloneStatus = 'already_cloned' | 'cloned' | 'no_repository_url' | 'clone_failed' | 'would_clone';

export async function runCloneDependencies(opts: { dryRun?: boolean } = {}): Promise<void> {
  phase('clone-dependencies');
  const arr = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), PROPOSAL), 'utf-8')) as any[];
  const pairsByLib = new Map<string, Set<string>>();
  for (const e of arr) {
    if (!e?.npm_pkg || !e.prev?.version || !e.updated?.version) continue;
    const set = pairsByLib.get(e.npm_pkg) ?? new Set<string>();
    set.add(`${e.prev.version}|${e.updated.version}`);
    pairsByLib.set(e.npm_pkg, set);
  }

  // 依存パッケージ → それを使うライブラリ・調べるバージョン（範囲の下限）
  const usedBy = new Map<string, Set<string>>();
  const versionsOf = new Map<string, Set<string>>();
  let libIndex = 0;
  for (const [lib, pairs] of pairsByLib) {
    libIndex++;
    progress({ lib, libIndex, libTotal: pairsByLib.size, step: 'registry' });
    const packument = await fetchPackument(lib);
    if (!packument) { logEvent('warn', 'npm registry doc 取得失敗', { lib }); continue; }
    for (const pair of pairs) {
      const [pre, post] = pair.split('|');
      for (const d of diffDeps(packument.versions?.[pre], packument.versions?.[post])) {
        if (d.kind !== 'dependencies' || (d.change !== 'major-bump' && d.change !== 'minor-patch-bump')) continue;
        (usedBy.get(d.name) ?? usedBy.set(d.name, new Set()).get(d.name)!).add(lib);
        const versions = versionsOf.get(d.name) ?? versionsOf.set(d.name, new Set()).get(d.name)!;
        for (const range of [d.preRange, d.postRange]) {
          const v = safeMinVersion(range);
          if (v) versions.add(v);
        }
      }
    }
  }

  // 調べるバージョンの repository ごとに clone する（同じパッケージでもバージョンでリポジトリが違うことがある．例 frameguard 3.x は helmetjs/frameguard，4.0.0 は helmetjs/helmet）
  const rows: { dependency: string; status: CloneStatus; repositoryUrl: string; cloneDir: string; versions: string; usedBy: string }[] = [];
  let index = 0;
  for (const [dependency, libs] of [...usedBy.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    index++;
    progress({ lib: dependency, libIndex: index, libTotal: usedBy.size, step: 'clone' });
    const packument = await fetchPackument(dependency);
    const latest = packument?.['dist-tags']?.latest;
    const versionsByUrl = new Map<string, string[]>();
    let missing: string[] = [];
    for (const v of [...(versionsOf.get(dependency) ?? [])].sort()) {
      const url = repositoryUrlOf(packument?.versions?.[v] ?? packument?.versions?.[latest] ?? packument);
      if (!url) { missing.push(v); continue; }
      (versionsByUrl.get(url) ?? versionsByUrl.set(url, []).get(url)!).push(v);
    }
    const usedByText = [...libs].sort().join(';');
    if (missing.length > 0 || versionsByUrl.size === 0) {
      rows.push({ dependency, status: 'no_repository_url', repositoryUrl: '', cloneDir: '', versions: missing.join(';'), usedBy: usedByText });
      logEvent('warn', 'repository URL を特定できない', { lib: dependency, versions: missing.join(';') });
    }
    for (const [url, versions] of versionsByUrl) {
      const repoDir = path.resolve(process.cwd(), DEPENDENCY_CLONE_BASE, toDirName(dependency), repoDirName(url));
      const row = { dependency, status: 'already_cloned' as CloneStatus, repositoryUrl: url, cloneDir: path.relative(path.resolve(process.cwd(), DEPENDENCY_CLONE_BASE), repoDir), versions: versions.join(';'), usedBy: usedByText };
      rows.push(row);
      if (fs.existsSync(path.join(repoDir, '.git'))) continue;
      if (opts.dryRun) { row.status = 'would_clone'; continue; }
      try {
        fs.mkdirSync(path.dirname(repoDir), { recursive: true });
        LibRepo.ensureClone(url, repoDir, process.env.GITHUB_TOKEN);
        row.status = 'cloned';
      } catch (e: any) {
        row.status = 'clone_failed';
        logEvent('error', `clone 失敗: ${e?.message ?? e}`, { lib: dependency, url });
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const logDir = runLogSummary().dir;
  if (logDir) {
    fs.writeFileSync(path.join(logDir, 'dependency_clone_summary.csv'),
      ['dependency,status,repository_url,clone_dir,versions,used_by', ...rows.map(r => [r.dependency, r.status, r.repositoryUrl, r.cloneDir, r.versions, r.usedBy].map(toCsvCell).join(','))].join('\n') + '\n');
  }
  console.log(`[Done] 依存パッケージ ${usedBy.size} 件・clone ${rows.filter(r => r.cloneDir).length} 件 → ${path.resolve(process.cwd(), DEPENDENCY_CLONE_BASE)}（${JSON.stringify(counts)}）`);
}

/** バージョンのメタの repository を clone できる URL にする（GitHub の owner/repo・github:owner/repo の省略形も） */
export function repositoryUrlOf(versionMeta: any): string | null {
  const repo = versionMeta?.repository;
  const raw: string | undefined = typeof repo === 'string' ? repo : repo?.url;
  if (raw && /^(github:)?[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw.replace(/^github:/, '').replace(/\.git$/, '')}`;
  return extractRepositoryUrl(versionMeta);
}

/** clone の置き場の名前（URL の owner と repo．例 https://github.com/helmetjs/frameguard → helmetjs__frameguard） */
export function repoDirName(url: string): string {
  const parts = url.replace(/\.git$/, '').replace(/\/+$/, '').split('/');
  return `${parts[parts.length - 2] ?? 'unknown'}__${parts[parts.length - 1] ?? 'unknown'}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function safeMinVersion(range?: string): string | null {
  if (!range) return null;
  try {
    return semver.minVersion(range)?.version ?? null;
  } catch {
    return null;
  }
}

// CLI 直接実行時のみ。CLONE_DRY_RUN=1 で clone せずに数だけ出す
if (process.argv[1] && /cloneDependencies\.(ts|js)$/.test(process.argv[1])) {
  initRunLog('clone-dependencies');
  runCloneDependencies({ dryRun: process.env.CLONE_DRY_RUN === '1' })
    .catch(e => { logEvent('error', `[Fatal] ${e?.stack ?? e}`); console.error('[Fatal]', e); process.exit(1); });
}
