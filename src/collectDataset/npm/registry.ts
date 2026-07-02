// ==========================================
// npm registry アクセス
// ------------------------------------------
// 対象ライブラリの公開バージョン一覧を取得し target の「一つ前」を決定
// ライブラリの git リポジトリ URL も取得（pre/post clone 用）
// ==========================================

import semver from 'semver';
import type { ResolvedVersions } from '../types';

const REGISTRY = 'https://registry.npmjs.org';

/** スコープ付き(@scope/name)にも対応した encode */
function encodePkg(libraryName: string): string {
  // "@scope/name" → "@scope%2Fname"
  return libraryName.startsWith('@')
    ? '@' + encodeURIComponent(libraryName.slice(1))
    : encodeURIComponent(libraryName);
}

/**
 * 公開バージョン一覧を取得（軽量な abbreviated metadata を使用）
 */
export async function fetchVersionList(libraryName: string): Promise<string[]> {
  const res = await fetch(`${REGISTRY}/${encodePkg(libraryName)}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!res.ok) {
    throw new Error(`npm registry からバージョン一覧を取得できません: ${libraryName} (HTTP ${res.status})`);
  }
  const doc = (await res.json()) as { versions?: Record<string, unknown> };
  return Object.keys(doc.versions ?? {});
}

/**
 * 特定バージョンのメタデータ（repository 情報を含む）を取得
 */
export async function fetchVersionMeta(libraryName: string, version: string): Promise<any> {
  const res = await fetch(`${REGISTRY}/${encodePkg(libraryName)}/${version}`);
  if (!res.ok) {
    throw new Error(`npm registry からバージョンメタを取得できません: ${libraryName}@${version} (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * target（更新後）に対する「一つ前」を決定
 * - 「一つ前」= target より厳密に小さい公開版のうち最大
 * - 既定では target がプレリリースでない限り候補からプレリリースを除外
 */
export function resolvePreviousVersion(
  libraryName: string,
  allVersions: string[],
  targetVersion: string,
  includePrerelease = false
): ResolvedVersions {
  const post = semver.valid(targetVersion);
  if (!post) {
    throw new Error(`targetVersion が不正な semver です: ${targetVersion}`);
  }

  const targetIsPre = semver.prerelease(post) !== null;
  // 候補: 正当な semver のみ / target が安定版なら候補もプレリリース除外
  const candidates = allVersions
    .filter((v) => semver.valid(v))
    .filter((v) => (includePrerelease || targetIsPre ? true : semver.prerelease(v) === null))
    .sort(semver.compare);

  if (!candidates.includes(post)) {
    // target 自体が一覧に無くても、それより前を探せれば続行可能だが、
    // 取り違いを避けるため明示的にエラー
    throw new Error(`target ${targetVersion} が ${libraryName} の公開バージョンに見つかりません`);
  }

  const lowers = candidates.filter((v) => semver.lt(v, post));
  if (lowers.length === 0) {
    throw new Error(`${libraryName}@${targetVersion} より前のバージョンが存在しません`);
  }
  const preVersion = lowers[lowers.length - 1];

  return { libraryName, postVersion: post, preVersion, candidateVersions: candidates };
}

/**
 * バージョンメタの repository フィールドから https の GitHub URL を抽出
 * 取得できなければ null
 */
export function extractRepositoryUrl(versionMeta: any): string | null {
  const repo = versionMeta?.repository;
  let url: string | undefined = typeof repo === 'string' ? repo : repo?.url;
  if (!url) return null;

  url = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');

  if (url.startsWith('git@github.com:')) {
    url = 'https://github.com/' + url.slice('git@github.com:'.length);
  }
  if (url.startsWith('ssh://git@github.com/')) {
    url = 'https://github.com/' + url.slice('ssh://git@github.com/'.length);
  }
  return url;
}
