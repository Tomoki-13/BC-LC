// ==========================================
// クライアントリポジトリのクローン
// ------------------------------------------
// 収集したクライアント（owner/repo）を clonedata/codesearch_clientRepos/<lib>/ 配下に
// clone する。既存（中身あり）はスキップ。
// （R-BC の cloneRepoWithCommit を参考に child_process で実装）
// ==========================================

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** 認証付き URL（token があれば付与） */
function authedUrl(fullName: string, token: string | undefined): string {
  return token
    ? `https://x-access-token:${token}@github.com/${fullName}.git`
    : `https://github.com/${fullName}.git`;
}

/** ディレクトリが存在し、かつ空でない（中身がある）か */
export function hasContent(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export interface CloneClientResult {
  fullName: string;
  dir: string;
  status: 'cloned' | 'reused' | 'failed';
}

/**
 * クライアントを clone する。
 * @param fullName     owner/repo
 * @param libCloneBase clonedata/codesearch_clientRepos/<lib>
 * @param token        GITHUB_TOKEN
 * @param shallow      浅いクローン（既定 true。差分解析には別途取得する想定）
 */
export async function cloneClient(
  fullName: string,
  libCloneBase: string,
  token: string | undefined,
  shallow = true
): Promise<CloneClientResult> {
  const m = fullName.match(/^([^/]+)\/([^/]+)$/);
  if (!m) return { fullName, dir: '', status: 'failed' };

  const dir = path.resolve(process.cwd(), libCloneBase, m[1], m[2]);
  if (hasContent(dir)) {
    return { fullName, dir, status: 'reused' };
  }

  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const depth = shallow ? '--depth 1' : '';
    await execAsync(`git clone ${depth} "${authedUrl(fullName, token)}" "${dir}"`, {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { fullName, dir, status: 'cloned' };
  } catch (e) {
    console.error(`  [Warn] client clone 失敗: ${fullName}`);
    return { fullName, dir, status: 'failed' };
  }
}
