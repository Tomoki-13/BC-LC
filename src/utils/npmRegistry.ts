// ==========================================
// npm registry アクセス（共有インフラ）
// ------------------------------------------
// 対象ライブラリの公開バージョン一覧・版メタ・git repo URL を取得する。
// diff パイプライン（index/8-library/runSample/evaluation）と収集モジュール
// （collectDataset）の双方が使う共通アクセス層。
// ==========================================

import semver from 'semver';

const REGISTRY = 'https://registry.npmjs.org';

/** npm registry から解決したバージョン情報（resolvePreviousVersion の戻り値） */
export interface ResolvedVersions {
  libraryName: string;
  /** 更新後（= targetVersion を正規化したもの） */
  postVersion: string;
  /** 更新前（registry 上で post の直前に公開された版） */
  preVersion: string;
  /** semver 昇順に並べた候補バージョン一覧 */
  candidateVersions: string[];
}

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
 * - knownPrev を渡すと自動算出せずそれを prev に採用する（研究用途）。
 *   本研究のデータセットは prev がプレリリースの遷移（例 uuid 8.0.0-beta.0 → 8.0.0）を
 *   含み、自動算出では安定版 target からプレリリース prev を除外して取り違えるため、
 *   記録済みの prev をそのまま入力する。
 */
export function resolvePreviousVersion(
  libraryName: string,
  allVersions: string[],
  targetVersion: string,
  includePrerelease = false,
  knownPrev?: string,
): ResolvedVersions {
  const post = semver.valid(targetVersion);
  if (!post) {
    throw new Error(`targetVersion が不正な semver です: ${targetVersion}`);
  }

  // 記録済み prev を明示入力した場合は自動算出をスキップ
  if (knownPrev !== undefined) {
    const pre = semver.valid(knownPrev);
    if (!pre) {
      throw new Error(`knownPrev が不正な semver です: ${knownPrev}`);
    }
    if (!semver.lt(pre, post)) {
      throw new Error(`knownPrev(${knownPrev}) が target(${targetVersion}) より前ではありません`);
    }
    const candidates = allVersions.filter((v) => semver.valid(v)).sort(semver.compare);
    return { libraryName, postVersion: post, preVersion: pre, candidateVersions: candidates };
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
