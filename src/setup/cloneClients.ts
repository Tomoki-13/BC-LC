import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { CLIENTS_PATH, CLIENT_REPOS_BASE } from '../utils/evalShared';

// clonedata/clientRepos/<lib>/<owner>/<repo> に評価で使うクライアント repo を用意する（setup 段）。
//   R-BC setup.ts の cloneRepos を踏襲: clone → 対象コミット checkout → git clean。
//   入力は検出入力 clients.json（prepareClients 生成）。無いクライアントだけ clone し、既存は触らない。
//   commitId は client の固定スナップショット（S__commit_id・版に依らず一定）。lib 側は runDetection が別途 clone。

interface ClientEntry { npm_pkg: string; client: string; commitId: string }

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** dir が存在し中身がある（クローン済みとみなす） */
function isPresent(dir: string): boolean {
  try { return fs.existsSync(dir) && fs.readdirSync(dir).length > 0; } catch { return false; }
}

/** owner/repo の clone URL（GITHUB_TOKEN があれば認証付き） */
function cloneUrl(nameWithOwner: string): string {
  return GITHUB_TOKEN
    ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${nameWithOwner}.git`
    : `https://github.com/${nameWithOwner}.git`;
}

/** 1クライアントを clone して commit へ checkout（R-BC cloneRepos と同手順）。成功=true */
function cloneOne(nameWithOwner: string, commitId: string, repoDir: string): boolean {
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
  } catch {
    fs.rmSync(repoDir, { recursive: true, force: true }); // 中途半端な clone を残さない
    return false;
  }
}

/**
 * clients.json のクライアントを clonedata/clientRepos に揃える
 *   入力: なし（clients.json を読む）/ 出力: なし（clientRepos を更新）
 *   present=既存でスキップ / cloned=今回 clone 成功 / failed=clone 失敗
 */
export async function runCloneClients(opts: { sleepMs?: number } = {}): Promise<void> {
  const sleepMs = opts.sleepMs ?? 1500; // API 制限回避（clone した時のみ待つ）
  const clientsPath = path.resolve(process.cwd(), CLIENTS_PATH);
  if (!fs.existsSync(clientsPath)) {
    console.error(`[cloneClients] 検出入力が無い: ${clientsPath}（先に prepareClients）`);
    process.exit(1);
  }
  const entries: ClientEntry[] = JSON.parse(fs.readFileSync(clientsPath, 'utf-8'));

  // (lib, client) 単位に重複排除（同一 client は複数ペアに出るが commit は一定なので clone は1回）
  const uniq = new Map<string, { npm_pkg: string; client: string; commitId: string }>();
  for (const e of entries) uniq.set(`${e.npm_pkg}|${e.client}`, { npm_pkg: e.npm_pkg, client: e.client, commitId: e.commitId });

  const base = path.resolve(process.cwd(), CLIENT_REPOS_BASE);
  let present = 0, cloned = 0, failed = 0;
  const failures: string[] = [];
  let i = 0;
  for (const { npm_pkg, client, commitId } of uniq.values()) {
    i++;
    const repoDir = path.join(base, npm_pkg, client); // clientRepos/<lib>/<owner>/<repo>
    if (isPresent(repoDir)) { present++; continue; } // 既存はチェックのみでスキップ
    process.stderr.write(`\r[cloneClients] ${i}/${uniq.size} clone: ${npm_pkg}/${client}                `);
    const ok = cloneOne(client, commitId, repoDir);
    if (ok) cloned++; else { failed++; failures.push(`${npm_pkg}/${client}`); }
    await sleep(sleepMs);
  }
  process.stderr.write('\n');

  console.log(`[cloneClients] unique=${uniq.size} present=${present} cloned=${cloned} failed=${failed} → ${base}`);
  if (failures.length) console.log(`[cloneClients] 失敗 ${failures.length} 件（先頭）: ${failures.slice(0, 10).join(', ')}`);
}

// CLI 直接実行時のみ（setup.ts から import された時は走らせない）
if (process.argv[1] && /cloneClients\.(ts|js)$/.test(process.argv[1])) {
  runCloneClients().catch(e => { console.error('[Fatal]', e); process.exit(1); });
}
