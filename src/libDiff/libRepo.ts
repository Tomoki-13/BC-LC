import { execSync } from 'child_process';
import fs from 'fs';

/**
 * クローン用意（既存ならスキップ）
 * 入力: repoUrl(https GitHub URL) / repoDir(クローン先) / token(任意 GITHUB_TOKEN)
 * 全タグが必要なので shallow にしない
 */
function ensureClone(repoUrl: string, repoDir: string, token?: string): void {
  if (fs.existsSync(repoDir)) return;
  const base = repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : repoUrl;
  const url = token
    ? base.replace('https://github.com/', `https://x-access-token:${token}@github.com/`) + '.git'
    : base + '.git';
  execSync(`git clone "${url}" "${repoDir}"`, { stdio: 'ignore' });
}

/**
 * version に対応する実在タグを解決（"v<ver>" → "<ver>" の順）
 * 出力: 実在タグ名 / 無ければ null
 */
function resolveTag(repoDir: string, version: string): string | null {
  for (const tag of [`v${version}`, version]) {
    try {
      execSync(`git -C "${repoDir}" rev-parse --verify --quiet "refs/tags/${tag}"`, { stdio: 'ignore' });
      return tag;
    } catch {
      /* 次を試す */
    }
  }
  return null;
}

/** 単一クローンを指定タグへ checkout（-f で作業ツリー切替） */
function checkoutVersion(repoDir: string, tag: string): void {
  execSync(`git -C "${repoDir}" checkout -f "${tag}"`, { stdio: 'ignore' });
}

export default {
  ensureClone,
  resolveTag,
  checkoutVersion,
};
