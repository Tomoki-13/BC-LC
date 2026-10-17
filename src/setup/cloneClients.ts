import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { CLIENTS_PATH, CLIENT_REPOS_BASE, hasRepoContent } from '../utils/evalShared';
import { initRunLog, phase, progress, logEvent } from '../utils/runLog';

// clonedata/clientRepos/<lib>/<owner>/<repo> に評価で使うクライアント repo を用意する（setup 段）。
//   R-BC setup.ts の cloneRepos を踏襲: clone → 対象コミット checkout → git clean。
//   入力は検出入力 clients.json（prepareClients 生成）無いクライアントだけ clone し、既存は触らない
//   commitId は client の固定スナップショット（S__commit_id・版に依らず一定）。lib 側は runDetection が別途 clone。

interface ClientEntry { npm_pkg: string; client: string; commitId: string }

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** owner/repo の clone URL（GITHUB_TOKEN があれば認証付き） */
function cloneUrl(nameWithOwner: string): string {
  return GITHUB_TOKEN
    ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${nameWithOwner}.git`
    : `https://github.com/${nameWithOwner}.git`;
}

/** base まで遡って、空になった親ディレクトリ（owner/lib）を削除する */
function removeEmptyAncestors(startDir: string, base: string): void {
  let dir = startDir;
  while (dir.startsWith(base) && dir !== base) {
    try {
      if (fs.readdirSync(dir).length > 0) break; // 他の成功クローンが残っていれば止める
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/** base 配下（<lib>/<owner>/<repo> の3階層まで）の空ディレクトリを深い方から削除し、削除数を返す */
function removeEmptyDirs(base: string): number {
  let removed = 0;
  const visit = (dir: string, depth: number) => {
    if (depth < 3) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) visit(path.join(dir, ent.name), depth + 1);
      }
    }
    if (dir !== base && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      removed++;
    }
  };
  if (fs.existsSync(base)) visit(base, 0);
  return removed;
}

/** 1クライアントを clone して commit へ checkout（R-BC cloneRepos と同手順）。成功=true */
function cloneOne(nameWithOwner: string, commitId: string, repoDir: string, base: string): boolean {
  const ownerDir = path.dirname(repoDir);
  try {
    fs.mkdirSync(ownerDir, { recursive: true });
    execSync(`git clone ${cloneUrl(nameWithOwner)} "${repoDir}"`, { stdio: 'ignore' });
    // 依存の実体は評価では使わないので削除（静的解析のみ・容量削減）
    fs.rmSync(path.join(repoDir, 'package-lock.json'), { force: true });
    fs.rmSync(path.join(repoDir, 'node_modules'), { recursive: true, force: true });
    execSync(`git checkout ${commitId}`, { stdio: 'ignore', cwd: repoDir });
    execSync('git clean -fdx', { stdio: 'ignore', cwd: repoDir });
    return true;
  } catch (e: any) {
    // 失敗理由を記録（lib/client は progress の位置として自動で付く。URL のトークンは載せない）
    logEvent('error', `clone 失敗: ${String(e?.message ?? e).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')}`);
    fs.rmSync(repoDir, { recursive: true, force: true }); // 中途半端な clone を残さない
    removeEmptyAncestors(ownerDir, base);                 // 空になった owner/lib ディレクトリも掃除
    return false;
  }
}

/**
 * clients.json のクライアントを clonedata/clientRepos に揃える
 *   入力: なし（clients.json を読む）/ 出力: なし（clientRepos を更新）
 *   present=既存でスキップ / cloned=今回 clone 成功 / failed=clone 失敗 / emptyRecloned=空ディレクトリを消して clone し直した数
 *   空ディレクトリ（中身が .git だけのものも含む）は過去の clone 失敗の残骸なので、その場で削除して同じ順番で clone する
 */
export async function runCloneClients(
  opts: { sleepMs?: number; baseDir?: string; libsLimit?: number; clientsPerLib?: number } = {},
): Promise<void> {
  phase('clone-clients');
  const sleepMs = opts.sleepMs ?? 1500; // API 制限回避（clone した時のみ待つ）
  const clientsPath = path.resolve(process.cwd(), CLIENTS_PATH);
  if (!fs.existsSync(clientsPath)) {
    console.error(`[cloneClients] 検出入力が無い: ${clientsPath}（先に prepareClients）`);
    process.exit(1);
  }
  const entries: ClientEntry[] = JSON.parse(fs.readFileSync(clientsPath, 'utf-8'));

  // (lib, client) 単位に重複排除して lib ごとにまとめる（同一 client は複数ペアに出るが commit は一定なので clone は1回）
  const byLib = new Map<string, { npm_pkg: string; client: string; commitId: string }[]>();
  const seen = new Set<string>();
  for (const e of entries) {
    const k = `${e.npm_pkg}|${e.client}`;
    if (seen.has(k)) continue; seen.add(k);
    if (!byLib.has(e.npm_pkg)) byLib.set(e.npm_pkg, []);
    byLib.get(e.npm_pkg)!.push({ npm_pkg: e.npm_pkg, client: e.client, commitId: e.commitId });
  }
  let work = [...byLib.values()].flat();

  // -----------------------------------------------------------
  // デバッグ: 数を少なくするコード（検証用）
  //   libsLimit 個の lib × clientsPerLib 個の client だけに絞る。本番は opts 未指定で全件。
  // -----------------------------------------------------------
  if (opts.libsLimit !== undefined || opts.clientsPerLib !== undefined) {
    const nLibs = opts.libsLimit ?? Infinity;
    const nPer = opts.clientsPerLib ?? Infinity;
    work = [...byLib.entries()].slice(0, nLibs).flatMap(([, list]) => list.slice(0, nPer));
    console.log(`[cloneClients] デバッグ縮小: ${nLibs} lib × ${nPer} client = ${work.length} 件`);
  }
  // -----------------------------------------------------------

  // 出力先は既定 clientRepos。検証時は baseDir で一時ディレクトリに差し替え可能
  const base = path.resolve(process.cwd(), opts.baseDir ?? CLIENT_REPOS_BASE);
  let present = 0, cloned = 0, failed = 0, emptyRecloned = 0;
  const failures: string[] = [];
  for (let i = 0; i < work.length; i++) {
    const { npm_pkg, client, commitId } = work[i];
    const repoDir = path.join(base, npm_pkg, client); // <base>/<lib>/<owner>/<repo>
    progress({ lib: npm_pkg, client, index: i + 1, total: work.length });
    if (hasRepoContent(repoDir)) { present++; continue; } // 既存はチェックのみでスキップ
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true }); // 空（or .git のみ）の残骸を消してから clone し直す
      emptyRecloned++;
      logEvent('warn', '空のクライアントディレクトリを削除して clone し直す', { repoDir });
    }
    process.stderr.write(`\r[cloneClients] ${i + 1}/${work.length} clone: ${npm_pkg}/${client}                `);
    const ok = cloneOne(client, commitId, repoDir, base);
    if (ok) cloned++; else { failed++; failures.push(`${npm_pkg}/${client}`); }
    await sleep(sleepMs);
  }
  process.stderr.write('\n');
  // clients.json に無い lib/owner の空ディレクトリも残さない
  const sweptEmpty = removeEmptyDirs(base);

  console.log(`[cloneClients] target=${work.length} present=${present} cloned=${cloned} failed=${failed}` +
    ` emptyRecloned=${emptyRecloned} sweptEmptyDirs=${sweptEmpty} → ${base}`);
  if (failures.length) console.log(`[cloneClients] 失敗 ${failures.length} 件（先頭）: ${failures.slice(0, 10).join(', ')}`);
}

// CLI 直接実行時のみ（setup.ts から import された時は走らせない）
//   CLONE_SAMPLE=1 で検証モード（5lib×5client を testclone/ に clone）。本番は無指定で全件を clientRepos へ
if (process.argv[1] && /cloneClients\.(ts|js)$/.test(process.argv[1])) {
  initRunLog('clone-clients');
  const sample = process.env.CLONE_SAMPLE === '1';
  const opts = sample ? { baseDir: '../../testclone', libsLimit: 5, clientsPerLib: 5 } : {};
  runCloneClients(opts).catch(e => { logEvent('error', `[Fatal] ${e?.stack ?? e}`); console.error('[Fatal]', e); process.exit(1); });
}
