import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { ResolveMethod } from '../types/LibDiff';

interface ResolveResult { ref: string | null; method: ResolveMethod; }

/**
 * クローン用意（既存の有効な clone があればスキップ）
 * 入力: repoUrl(https GitHub URL) / repoDir(クローン先) / token(任意 GITHUB_TOKEN)
 * 全タグ・全履歴が版解決に必要なので shallow にしない
 */
function ensureClone(repoUrl: string, repoDir: string, token?: string): void {
  if (fs.existsSync(path.join(repoDir, '.git'))) return;
  const base = repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : repoUrl;
  const url = token
    ? base.replace('https://github.com/', `https://x-access-token:${token}@github.com/`) + '.git'
    : base + '.git';
  execSync(`git clone "${url}" "${repoDir}"`, { stdio: 'ignore' });
}

/**
 * version → checkout 可能な ref と、その解決手段を返す（監査ログ用）
 *   タグ("v1.2.3"/"1.2.3") → package.json version 履歴(Matsuda 方式) → gitHead → コミットメッセージ の順
 */
function resolveRefDetailed(repoDir: string, version: string, gitHead?: string | null): ResolveResult {
  const tag = resolveTag(repoDir, version);
  if (tag) return { ref: tag, method: 'tag' };
  const byPkg = resolveByPackageJson(repoDir, version);
  if (byPkg) return { ref: byPkg, method: 'package-json' };
  if (gitHead) {
    try { execSync(`git -C "${repoDir}" cat-file -t ${gitHead}`, { stdio: 'ignore' }); return { ref: gitHead, method: 'git-head' }; }
    catch { /* SHA が repo に無い→次へ */ }
  }
  const byMsg = resolveByCommitMessage(repoDir, version);
  if (byMsg) return { ref: byMsg, method: 'commit-message' };
  return { ref: null, method: 'unresolved' };
}

/** resolveRefDetailed の ref だけを返す（method 不要な呼び出し向け） */
function resolveRef(repoDir: string, version: string, gitHead?: string | null): string | null {
  return resolveRefDetailed(repoDir, version, gitHead).ref;
}

/** version に対応する実在タグを解決（"v<ver>" → "<ver>" の順）。無ければ null */
function resolveTag(repoDir: string, version: string): string | null {
  for (const tag of [`v${version}`, version]) {
    try {
      execSync(`git -C "${repoDir}" rev-parse --verify --quiet "refs/tags/${tag}"`, { stdio: 'ignore' });
      return tag;
    } catch {
      /* 次を試す（意図的な空 catch） */
    }
  }
  return null;
}

/** 単一クローンを指定 ref へ checkout（-f で作業ツリー強制切替） */
function checkoutVersion(repoDir: string, ref: string): void {
  execSync(`git -C "${repoDir}" checkout -f "${ref}"`, { stdio: 'ignore' });
}

/** 正規表現メタ文字をエスケープ（version 中の . - + 等） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * タグが無い版を「リリースコミットにバージョンを書く」慣習から解決（最終フォールバック）
 *   厳しい順に3段。最初に当たった段の中で最新コミットの SHA を返す
 *   1) メッセージがバージョンそのもの   例: "2.0.0" / "v2.0.0"
 *   2) 代表的なリリース表現            例: "Bumped 2.1.0" / "Release 1.0.0"
 *   3) 版がトークンとして単独出現       例: "version to v0.2.2"（緩め）
 */
function resolveByCommitMessage(repoDir: string, version: string): string | null {
  let log: string;
  try {
    // %x1f = Unit Separator でハッシュと subject を区切る / --all: HEAD 祖先に限らず全 ref
    log = execSync(`git -C "${repoDir}" log --all --format=%H%x1f%s`,
      { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
  } catch { return null; }
  const entries = log.split('\n').filter(Boolean).map(l => {
    const i = l.indexOf('\x1f'); return { sha: l.slice(0, i), subj: l.slice(i + 1) };
  });
  const v = escapeRe(version);
  const tiers = [
    new RegExp(`^v?${v}$`),
    new RegExp(`^(bumped?|released?|version)( (to|up))? v?${v}\\.?$`, 'i'),
    new RegExp(`(^|[^\\w.])v?${v}([^\\w.]|$)`),  // 12.0.0 内の 2.0.0 等の部分一致を避ける
  ];
  for (const re of tiers) {
    const hit = entries.find(e => re.test(e.subj)); // entries は新しい順、最初の一致を採用
    if (hit) return hit.sha;
  }
  return null;
}

// repoDir → (version → hash) の解決済みマップ（プロセス内キャッシュ）
const versionMapCache = new Map<string, Map<string, string>>();

/**
 * package.json の version フィールド履歴から version → 初出コミット hash を作る（Matsuda 方式）
 *   タグ/gitHead に依存せず権威的。repo 単位でキャッシュ
 */
function buildVersionMap(repoDir: string): Map<string, string> {
  const cached = versionMapCache.get(repoDir);
  if (cached) return cached;
  const map = new Map<string, string>();
  try {
    // package.json を変更したコミットのみ（--reverse=最古から / --all=HEAD 非依存）
    const commits = execSync(`git -C "${repoDir}" log --all --reverse --format=%H -- package.json`,
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    for (const c of commits) {
      let raw: string;
      try { raw = execSync(`git -C "${repoDir}" show ${c}:package.json`, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }); }
      catch { continue; }
      let v: string | undefined;
      try { v = JSON.parse(raw).version; } catch { continue; }
      if (v && !map.has(v)) map.set(v, c); // 初出（=そのバージョンへ上げたコミット）を採用
    }
  } catch { /* log 失敗時は空 */ }
  versionMapCache.set(repoDir, map);
  return map;
}

/** package.json version 履歴から version の hash を引く */
function resolveByPackageJson(repoDir: string, version: string): string | null {
  return buildVersionMap(repoDir).get(version) ?? null;
}

export default {
  ensureClone,
  resolveRefDetailed,
  resolveRef,
  resolveTag,
  checkoutVersion,
};
