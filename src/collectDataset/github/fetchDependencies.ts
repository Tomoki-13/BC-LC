// ==========================================
// クライアント package.json の依存取得
// ------------------------------------------
// GitHub contents API で package.json を取得し、dependencies / devDependencies を返す。
// （参照リポジトリ how-clients-use-the-library-version の fetchDependencies を fetch ベースに移植）
// ==========================================

import { ghHeaders } from './githubClient';

export interface Dependencies {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * 指定リポジトリの package.json を取得して依存関係を返す。
 * 失敗時は空オブジェクト。
 * @param fullName owner/repo
 * @param pkgPath  リポジトリ内の package.json パス
 */
export async function fetchDependencies(
  fullName: string,
  pkgPath: string,
  token: string | undefined
): Promise<Dependencies> {
  const url = `https://api.github.com/repos/${fullName}/contents/${pkgPath}`;
  try {
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      console.error(`  [Warn] package.json 取得失敗: ${fullName}/${pkgPath} (HTTP ${res.status})`);
      return {};
    }
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content) return {};
    const content = Buffer.from(data.content, (data.encoding as BufferEncoding) || 'base64').toString('utf-8');
    const pkg = JSON.parse(content);
    return {
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
    };
  } catch (e) {
    console.error(`  [Warn] package.json 解析失敗: ${fullName}/${pkgPath}`);
    return {};
  }
}
