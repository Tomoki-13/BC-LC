// ==========================================
// クライアント品質フィルタ
// ------------------------------------------
// 収集するクライアントが「一定の開発実績・品質」を満たすかを
// GitHub リポジトリのメタデータ（スター数・最終更新・archived/fork 等）で判定する。
// 閾値は QualityCriteria で調整可能。条件は README に記載。
// ==========================================

import { ghHeaders } from './githubClient';

export interface RepoMeta {
  full_name: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string; // ISO8601
  archived: boolean;
  fork: boolean;
  size: number; // KB
}

export interface QualityCriteria {
  /** 最低スター数 */
  minStars: number;
  /** 最終 push からの経過日数の上限（これより古いと「活動なし」で除外） */
  maxInactiveDays: number;
  /** fork リポジトリを除外するか */
  excludeForks: boolean;
  /** archived リポジトリを除外するか */
  excludeArchived: boolean;
}

/** 既定の品質条件（README に明記） */
export const DEFAULT_QUALITY: QualityCriteria = {
  minStars: 5,
  maxInactiveDays: 365 * 3, // 直近3年以内に更新
  excludeForks: true,
  excludeArchived: true,
};

/** リポジトリのメタデータを取得（失敗時 null） */
export async function fetchRepoMeta(
  fullName: string,
  token: string | undefined
): Promise<RepoMeta | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Partial<RepoMeta>;
    return {
      full_name: d.full_name ?? fullName,
      stargazers_count: d.stargazers_count ?? 0,
      forks_count: d.forks_count ?? 0,
      open_issues_count: d.open_issues_count ?? 0,
      pushed_at: d.pushed_at ?? '1970-01-01T00:00:00Z',
      archived: d.archived ?? false,
      fork: d.fork ?? false,
      size: d.size ?? 0,
    };
  } catch {
    return null;
  }
}

/** 品質条件を満たすか判定。満たさない場合は reason に理由を返す。 */
export function meetsQuality(
  meta: RepoMeta,
  c: QualityCriteria
): { ok: boolean; reason?: string } {
  if (c.excludeArchived && meta.archived) return { ok: false, reason: 'archived' };
  if (c.excludeForks && meta.fork) return { ok: false, reason: 'fork' };
  if (meta.stargazers_count < c.minStars) {
    return { ok: false, reason: `stars<${c.minStars}(${meta.stargazers_count})` };
  }
  const inactiveDays = (Date.now() - new Date(meta.pushed_at).getTime()) / 86_400_000;
  if (inactiveDays > c.maxInactiveDays) {
    return { ok: false, reason: `inactive>${c.maxInactiveDays}d(${Math.round(inactiveDays)}d)` };
  }
  return { ok: true };
}
