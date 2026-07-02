// ==========================================
// クライアントリポジトリ検索
// ------------------------------------------
// GitHub code search で「対象ライブラリを package.json に含むリポジトリ」を探し、
//   (1) 依存レンジが「一つ前(pre)を使い post 未満」か
//   (2) リポジトリが一定の開発実績・品質を満たすか
// の両方を通ったものだけを採用
// （参照リポジトリ how-clients-use-the-library-version の searchRepositories を
//   fetch ベース＋バージョン絞り込み＋品質フィルタに拡張）
// ==========================================

import type { ClientHit } from '../types';
import { ghHeaders, sleep } from './githubClient';
import { fetchDependencies } from './fetchDependencies';
import { usesPreviousVersion } from '../filter/versionFilter';
import { fetchRepoMeta, meetsQuality, type QualityCriteria } from './repoQuality';

interface CodeSearchItem {
  path: string;
  repository: { name: string; full_name: string };
}

export interface SearchOptions {
  libraryName: string;
  preVersion: string;
  postVersion: string;
  /** 追加で集めたい件数（既存分を除いた残り） */
  needed: number;
  /** 既に採用済みの owner/repo（重複回収を避ける） */
  exclude: Set<string>;
  quality: QualityCriteria;
  token: string | undefined;
}

/**
 * pre を使い、かつ品質条件を満たすクライアントを needed 件まで収集
 */
export async function searchRepositories(opts: SearchOptions): Promise<ClientHit[]> {
  const { libraryName, preVersion, postVersion, needed, exclude, quality, token } = opts;

  if (needed <= 0) return [];
  if (!token) {
    console.error('[Error] GITHUB_TOKEN が未設定です。code search API には認証が必要です。');
    return [];
  }

  const BASE_URL = 'https://api.github.com/search/code';
  const query = `"${libraryName}" filename:package.json language:JSON size:>0`;
  const perPage = 100;
  const maxPages = 10; // code search は最大 1000 件

  const accepted = new Map<string, ClientHit>();
  const seen = new Set<string>(exclude); // 評価済み（重複・既存）

  try {
    for (let page = 1; page <= maxPages && accepted.size < needed; page++) {
      const params = new URLSearchParams({
        q: query,
        per_page: String(perPage),
        page: String(page),
        sort: 'indexed',
        order: 'desc',
      });
      const res = await fetch(`${BASE_URL}?${params.toString()}`, {
        headers: { ...ghHeaders(token), Accept: 'application/vnd.github.v3.text-match+json' },
      });
      if (!res.ok) {
        console.error(`[Error] code search 失敗: HTTP ${res.status} ${await res.text()}`);
        break;
      }
      const body = (await res.json()) as { items?: CodeSearchItem[] };
      const items = body.items ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        if (accepted.size >= needed) break;
        const fullName = item.repository.full_name;
        if (seen.has(fullName)) continue;
        seen.add(fullName);

        // (1) バージョン絞り込み
        const deps = await fetchDependencies(fullName, item.path, token);
        const range = deps.dependencies?.[libraryName] ?? deps.devDependencies?.[libraryName];
        const depType: 'dependencies' | 'devDependencies' =
          deps.dependencies?.[libraryName] !== undefined ? 'dependencies' : 'devDependencies';
        if (!range || !usesPreviousVersion(range, preVersion, postVersion)) {
          await sleep(1500);
          continue;
        }

        // (2) 品質フィルタ
        const meta = await fetchRepoMeta(fullName, token);
        if (!meta) {
          await sleep(1500);
          continue;
        }
        const q = meetsQuality(meta, quality);
        if (!q.ok) {
          console.log(`  [Skip] ${fullName}  (${q.reason})`);
          await sleep(1500);
          continue;
        }

        accepted.set(fullName, {
          fullName,
          packageJsonPath: item.path,
          declaredRange: range,
          depType,
          stars: meta.stargazers_count,
          forks: meta.forks_count,
          pushedAt: meta.pushed_at,
        });
        console.log(`  [Hit] ${fullName}  (${libraryName}@"${range}", ★${meta.stargazers_count})`);
        await sleep(2000);
      }
      await sleep(1000);
    }
  } catch (e) {
    console.error('[Error] searchRepositories で例外:', e);
  }

  return Array.from(accepted.values()).slice(0, needed);
}
