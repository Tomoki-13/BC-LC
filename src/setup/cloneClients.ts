import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { CLIENTS_PATH, CLIENT_REPOS_BASE, hasRepoContent, isAtCommit } from '../utils/evalShared';
import { initRunLog, phase, progress, logEvent, runLogSummary } from '../utils/runLog';

// clonedata/clientRepos/<lib>/<owner>/<repo> に評価で使うクライアント repo を用意する（setup 段）。
//   R-BC setup.ts の cloneRepos を踏襲: clone → 対象コミット checkout → git clean。
//   入力は検出入力 clients.json（prepareClients 生成）。commitId は client の固定スナップショット（S__commit_id・lib×client で一意）。
//   既にあるクローンも commitId に checkout し直す（clientRepos は ClientFixTrace と共有で、ClientFixTrace の verHist は
//   作業ツリーを既定ブランチに戻す。clone もしているが commitId には合わせない）。
//   commitId がクローンに無く、取り寄せもできないクライアントは削除せずに残して記録する
//   （ClientFixTrace の verHist は履歴だけを読むので使える。BC-LC の検出は HEAD を見て走査から外す）。
//   lib 側は runDetection が別途 clone。

interface ClientEntry { npm_pkg: string; client: string; commitId: string }

/**
 * 1クライアントの結果
 *   aligned        既に commitId（何もしない）
 *   checkedOut     既存のクローンを commitId に checkout し直した
 *   fetched        commitId がクローンに無く、origin から取り寄せて checkout した
 *   cloned         今回 clone して commitId に checkout した
 *   noCommit       commitId がクローンに無く取り寄せもできない（残す。検出は HEAD を見て走査から外す）
 *   cloneFailed    clone 自体に失敗した（ディレクトリは残さない）
 *   checkoutFailed commitId はあるが checkout に失敗した（残す。検出は HEAD を見て走査から外す）
 *   wouldSync / wouldClone  dry-run で、実行すれば checkout / clone するもの
 */
type SyncResult = 'aligned' | 'checkedOut' | 'fetched' | 'cloned' | 'noCommit' | 'cloneFailed' | 'checkoutFailed'
  | 'wouldSync' | 'wouldClone';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const FETCH_TIMEOUT_MS = 120_000;

/** owner/repo の clone URL（GITHUB_TOKEN があれば認証付き） */
function cloneUrl(nameWithOwner: string): string {
  return GITHUB_TOKEN
    ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${nameWithOwner}.git`
    : `https://github.com/${nameWithOwner}.git`;
}

/** エラーメッセージからトークンを伏せる */
const redact = (e: any) => String(e?.message ?? e).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');

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

/** repoDir とその空になった親を消す */
//   消せなくても全体は止めない（git の後始末が残っていると ENOTEMPTY になることがある。残ったものは次回の空ディレクトリ掃除で消える）
function removeRepo(repoDir: string, base: string): void {
  try {
    fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (e) {
    logEvent('error', `ディレクトリを削除できない: ${redact(e)}`, { repoDir });
    return;
  }
  removeEmptyAncestors(path.dirname(repoDir), base);
}

/** クローンに commitId のコミットがあるか */
function hasCommit(repoDir: string, commitId: string): boolean {
  try {
    execSync(`git cat-file -e ${commitId}^{commit}`, { stdio: 'ignore', cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

/** origin から commitId だけを取り寄せる（force push で枝から外れたコミットも GitHub は SHA 指定で返すことがある） */
function fetchCommit(repoDir: string, commitId: string): boolean {
  try {
    execSync(`git fetch --quiet origin ${commitId}`, { stdio: 'ignore', cwd: repoDir, timeout: FETCH_TIMEOUT_MS });
  } catch {
    return false;
  }
  return hasCommit(repoDir, commitId);
}

/**
 * 作業ツリーを commitId にそろえる（既存・新規の共通手順）
 *   checkout -f: ClientFixTrace の reset 等で残った変更があっても上書きする（クローンは解析用で、手で変える物は無い）
 *   clean -fdx : 無視ファイル（node_modules 等）も含めて、そのコミットに無いファイルを消す
 *   package-lock.json はコミットの中身なので消さない（依存の経路の判定がロックファイルを読む）
 * 戻り値: 'ok' / 'noCommit'（取り寄せても無い） / 'failed'（その他の失敗）。fetched は取り寄せたか
 */
function checkoutTo(repoDir: string, commitId: string): { result: 'ok' | 'noCommit' | 'failed'; fetched: boolean } {
  let fetched = false;
  if (!hasCommit(repoDir, commitId)) {
    if (!fetchCommit(repoDir, commitId)) return { result: 'noCommit', fetched };
    fetched = true;
  }
  try {
    execSync(`git checkout -f --detach ${commitId}`, { stdio: 'ignore', cwd: repoDir });
    execSync('git clean -fdx', { stdio: 'ignore', cwd: repoDir });
  } catch (e) {
    logEvent('error', `checkout 失敗: ${redact(e)}`, { repoDir, commitId });
    return { result: 'failed', fetched };
  }
  // checkout が成功扱いでも HEAD が違えば失敗（念のため）
  return { result: isAtCommit(repoDir, commitId) ? 'ok' : 'failed', fetched };
}

/** 既にあるクローンを commitId にそろえる */
function syncExisting(repoDir: string, commitId: string, dryRun: boolean): SyncResult {
  if (isAtCommit(repoDir, commitId)) return 'aligned';
  if (dryRun) return 'wouldSync';
  const { result, fetched } = checkoutTo(repoDir, commitId);
  if (result === 'ok') return fetched ? 'fetched' : 'checkedOut';
  logEvent('warn', result === 'noCommit' ? 'commitId がクローンに無く取り寄せもできない（残す）' : 'checkout に失敗（残す）',
    { repoDir, commitId });
  return result === 'noCommit' ? 'noCommit' : 'checkoutFailed';
}

/** 1クライアントを clone して commitId に checkout（R-BC cloneRepos と同手順） */
function cloneOne(nameWithOwner: string, commitId: string, repoDir: string, base: string): SyncResult {
  try {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    execSync(`git clone ${cloneUrl(nameWithOwner)} "${repoDir}"`, { stdio: 'ignore' });
  } catch (e) {
    // 失敗理由を記録（lib/client は progress の位置として自動で付く。URL のトークンは載せない）
    logEvent('error', `clone 失敗: ${redact(e)}`);
    removeRepo(repoDir, base); // 中途半端な clone と、空になった owner/lib ディレクトリを残さない
    return 'cloneFailed';
  }
  const { result } = checkoutTo(repoDir, commitId);
  if (result === 'ok') return 'cloned';
  // 既存のクローンと同じく残す（verHist は履歴だけを読むので使える。検出は HEAD を見て走査から外す）
  logEvent('warn', result === 'noCommit' ? 'clone したが commitId が無い（残す）' : 'clone したが checkout できない（残す）',
    { repoDir, commitId });
  return result === 'noCommit' ? 'noCommit' : 'checkoutFailed';
}

/**
 * clients.json のクライアントを clonedata/clientRepos に、テストしたときのコミット（commitId）でそろえる
 *   入力: なし（clients.json を読む）/ 出力: なし（clientRepos を更新）
 *   既にあるクローンも checkout し直す（aligned は何もしない）。空ディレクトリ（.git だけのものも含む）は過去の clone 失敗の残骸なので、
 *   その場で削除して同じ順番で clone する
 *   dryRun: 何も変えずに、そろっている数・checkout が要る数・clone が要る数だけを数える（make check-clients）
 */
export async function runCloneClients(
  opts: { sleepMs?: number; baseDir?: string; libsLimit?: number; clientsPerLib?: number; dryRun?: boolean } = {},
): Promise<void> {
  phase('clone-clients');
  const sleepMs = opts.sleepMs ?? 1500; // API 制限回避（ネットワークに出た時のみ待つ）
  const dryRun = opts.dryRun ?? false;
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
  const counts: Record<SyncResult, number> = {
    aligned: 0, checkedOut: 0, fetched: 0, cloned: 0, noCommit: 0, cloneFailed: 0, checkoutFailed: 0, wouldSync: 0, wouldClone: 0,
  };
  let emptyRecloned = 0;
  const problems: string[] = [];
  const notAtCommit: { npm_pkg: string; client: string; commitId: string; result: SyncResult }[] = [];
  for (let i = 0; i < work.length; i++) {
    const { npm_pkg, client, commitId } = work[i];
    const repoDir = path.join(base, npm_pkg, client); // <base>/<lib>/<owner>/<repo>
    progress({ lib: npm_pkg, client, index: i + 1, total: work.length });
    let r: SyncResult;
    if (hasRepoContent(repoDir)) {
      r = syncExisting(repoDir, commitId, dryRun);
    } else if (dryRun) {
      r = 'wouldClone';
    } else {
      if (fs.existsSync(repoDir)) {
        fs.rmSync(repoDir, { recursive: true, force: true }); // 空（or .git のみ）の残骸を消してから clone し直す
        emptyRecloned++;
        logEvent('warn', '空のクライアントディレクトリを削除して clone し直す', { repoDir });
      }
      process.stderr.write(`\r[cloneClients] ${i + 1}/${work.length} clone: ${npm_pkg}/${client}                `);
      r = cloneOne(client, commitId, repoDir, base);
    }
    counts[r]++;
    if (r === 'noCommit' || r === 'cloneFailed' || r === 'checkoutFailed') {
      problems.push(`${r}:${npm_pkg}/${client}`);
      notAtCommit.push({ npm_pkg, client, commitId, result: r });
    }
    if (r === 'cloned' || r === 'cloneFailed' || r === 'fetched' || r === 'noCommit') await sleep(sleepMs);
  }
  process.stderr.write('\n');
  // clients.json に無い lib/owner の空ディレクトリも残さない
  const sweptEmpty = dryRun ? 0 : removeEmptyDirs(base);

  const shown = (Object.entries(counts) as [SyncResult, number][])
    .filter(([k, v]) => v > 0 || (!dryRun && !k.startsWith('would'))).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[cloneClients]${dryRun ? ' (dry-run・何も変えていない)' : ''} target=${work.length} ${shown}` +
    (dryRun ? '' : ` emptyRecloned=${emptyRecloned} sweptEmptyDirs=${sweptEmpty}`) + ` → ${base}`);
  logEvent('log', 'clone-clients 集計', { dryRun, target: work.length, ...counts, emptyRecloned, sweptEmpty });
  if (problems.length) console.log(`[cloneClients] テストしたときのコミットにできないクライアント ${problems.length} 件（先頭）: ${problems.slice(0, 10).join(', ')}`);
  // 一覧を実行ログの置き場に残す（検出で走査から外れる理由の確認用）
  const logDir = runLogSummary().dir;
  if (logDir && !dryRun) {
    const csv = 'npm_pkg,client,commitId,result\n' + notAtCommit.map(x => `${x.npm_pkg},${x.client},${x.commitId},${x.result}`).join('\n');
    fs.writeFileSync(path.join(logDir, 'clients_not_at_commit.csv'), csv);
    console.log(`[cloneClients] 一覧 → ${path.join(logDir, 'clients_not_at_commit.csv')}`);
  }
}

// CLI 直接実行時のみ（setup.ts から import された時は走らせない）
//   CLONE_SAMPLE=1 で検証モード（5lib×5client を testclone/ に clone）。本番は無指定で全件を clientRepos へ
//   CLONE_DRY_RUN=1 で何も変えずに数だけ出す（make check-clients）
if (process.argv[1] && /cloneClients\.(ts|js)$/.test(process.argv[1])) {
  initRunLog('clone-clients');
  const sample = process.env.CLONE_SAMPLE === '1';
  const opts = sample ? { baseDir: '../../testclone', libsLimit: 5, clientsPerLib: 5 } : {};
  runCloneClients({ ...opts, dryRun: process.env.CLONE_DRY_RUN === '1' })
    .catch(e => { logEvent('error', `[Fatal] ${e?.stack ?? e}`); console.error('[Fatal]', e); process.exit(1); });
}
