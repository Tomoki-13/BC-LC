// ==========================================
// バージョン絞り込み
// ------------------------------------------
// クライアントの package.json に宣言された依存レンジが、
// 「一つ前のバージョン（pre）を使い、まだ更新後（post）には移行していない」
// と判定できるかを semver で評価
// ==========================================

import semver from 'semver';

/**
 * クライアントの依存レンジが「pre を使い post を含まない」かを判定
 *
 * 例) target(post)=2.0.0, pre=1.4.0 のとき
 *   "^1.2.0" → pre を満たし post(2.0.0) を満たさない → true（採用）
 *   "^2.0.0" → post を満たす → false（既に更新後なので除外）
 *   ">=1.0.0" → post も満たしてしまう → false
 *
 * @param range クライアントが宣言した依存レンジ（例 "^1.4.0"）
 */
export function usesPreviousVersion(
  range: string,
  preVersion: string,
  postVersion: string
): boolean {
  const r = normalizeRange(range);
  if (r === null) return false;

  const satisfiesPre = semver.satisfies(preVersion, r, { includePrerelease: true });
  const satisfiesPost = semver.satisfies(postVersion, r, { includePrerelease: true });
  return satisfiesPre && !satisfiesPost;
}

/**
 * semver 評価できないレンジ（npm: エイリアス, git URL, "*", "latest", workspace: 等）を弾く
 * 評価可能なら正規化した文字列、不可なら null
 */
function normalizeRange(range: string): string | null {
  if (!range) return null;
  let r = range.trim();

  // npm エイリアス "npm:pkg@^1.0.0" → "^1.0.0"
  const aliasMatch = r.match(/^npm:[^@]+@(.+)$/);
  if (aliasMatch) r = aliasMatch[1];

  // git / url / workspace / file 系は semver 評価不能
  if (/^(git|https?|file|link|workspace|github):/i.test(r)) return null;
  if (r.includes('/')) return null; // "owner/repo#semver:..." 等
  if (r === '*' || r === '' || r === 'latest' || r === 'next') return null;

  return semver.validRange(r) ? r : null;
}
