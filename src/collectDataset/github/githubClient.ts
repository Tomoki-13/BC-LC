// ==========================================
// GitHub API 共通ヘルパ
// ------------------------------------------
// 認証ヘッダ生成と簡易レート制御。トークンは GITHUB_TOKEN に統一。
// ==========================================

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GITHUB_TOKEN（無ければ未認証＝レート制限が厳しい） */
export function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN;
}

/** GitHub REST API 用ヘッダ */
export function ghHeaders(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BC-LC-collectDataset',
  };
  if (token) h.Authorization = `token ${token}`;
  return h;
}
