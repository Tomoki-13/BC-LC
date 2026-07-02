// ==========================================
// ライブラリ本体 pre/post の取得と差分
// ------------------------------------------
// 対象ライブラリの git リポジトリを clone し、pre / post の各タグを解決して
// その間の unified diff と変更ファイル一覧を取得・保存する。
// （clone は R-BC の cloneRepoWithCommit を参考に child_process で実装）
// ==========================================

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ChangedFile, LibDiffResult } from '../types';

const execAsync = promisify(exec);

/** 認証付き URL（token があれば付与） */
function authedUrl(repoUrl: string, token: string | undefined): string {
  if (!token) return `${repoUrl}.git`;
  const m = repoUrl.match(/^https:\/\/github\.com\/(.+)$/);
  if (!m) return `${repoUrl}.git`;
  return `https://x-access-token:${token}@github.com/${m[1]}.git`;
}

/** version に対応する実在タグを解決（v<ver> → <ver> の順で試す） */
async function resolveTag(repoDir: string, version: string): Promise<string | null> {
  for (const tag of [`v${version}`, version]) {
    try {
      await execAsync(`git rev-parse --verify --quiet "refs/tags/${tag}"`, { cwd: repoDir });
      return tag;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * 対象ライブラリを clone して pre/post の差分を取得する。
 *
 * @param repoUrl        https://github.com/owner/repo 形式
 * @param libraryName    ライブラリ名（保存ディレクトリ名）
 * @param cloneBaseDir   clone 先ベース（例 ../../clonedata/lib_versions）
 * @param diffOutDir     diff(.patch) と結果 JSON の保存先
 * @param token          GITHUB_TOKEN
 */
export async function cloneLibVersions(
  repoUrl: string,
  libraryName: string,
  preVersion: string,
  postVersion: string,
  cloneBaseDir: string,
  diffOutDir: string,
  token: string | undefined
): Promise<LibDiffResult | null> {
  const safeName = libraryName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const repoDir = path.resolve(process.cwd(), cloneBaseDir, safeName);

  // 1) clone（既存ならスキップ）。タグ比較が必要なので shallow にしない。
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    console.log(`  [Clone] ${repoUrl} → ${repoDir}`);
    await execAsync(`git clone "${authedUrl(repoUrl, token)}" "${repoDir}"`);
  } else {
    console.log(`  [Clone] 既存を再利用: ${repoDir}`);
  }
  // タグを最新化
  await execAsync(`git fetch --tags --quiet`, { cwd: repoDir }).catch(() => {});

  // 2) タグ解決
  const preTag = await resolveTag(repoDir, preVersion);
  const postTag = await resolveTag(repoDir, postVersion);
  if (!preTag || !postTag) {
    console.error(
      `  [Error] タグを解決できません: pre=${preVersion}(${preTag}) post=${postVersion}(${postTag})`
    );
    return null;
  }

  // 3) 変更ファイル一覧（name-status）
  const { stdout: nameStatus } = await execAsync(
    `git diff --name-status "${preTag}" "${postTag}"`,
    { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 }
  );
  const changedFiles: ChangedFile[] = nameStatus
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status, file: rest.join('\t') };
    });

  // 4) unified diff（JS/TS のみ）を保存
  fs.mkdirSync(path.resolve(process.cwd(), diffOutDir), { recursive: true });
  const diffPath = path.resolve(
    process.cwd(),
    diffOutDir,
    `${safeName}_${preVersion}_to_${postVersion}.patch`
  );
  const { stdout: diff } = await execAsync(
    `git diff "${preTag}" "${postTag}" -- "*.js" "*.jsx" "*.ts" "*.tsx" "*.mjs" "*.cjs"`,
    { cwd: repoDir, maxBuffer: 256 * 1024 * 1024 }
  );
  fs.writeFileSync(diffPath, diff, 'utf8');

  console.log(`  [Diff] ${changedFiles.length} files changed → ${diffPath}`);

  return {
    libraryName,
    preVersion,
    postVersion,
    preTag,
    postTag,
    repoUrl,
    changedFiles,
    diffPath,
  };
}
