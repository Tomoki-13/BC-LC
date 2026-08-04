import semver from 'semver';

export type TimeMap = Record<string, string>;

const NON_VERSION_TIME_KEYS = new Set(['created', 'modified']);

/**
 * ある range が「asOf 時点で解決していたはずの具体バージョン」を求める
 *   入力: versions（依存の全公開版）/ timeMap（版→公開日）/ range（依存宣言の範囲）/ asOf（親libの公開日。無指定なら全版対象）
 *   出力: 解決版 or null（semver でない range・満たす版が無い・asOf 以前に版が無い場合）
 */
export function resolveVersionAsOf(
  versions: string[],
  timeMap: TimeMap | undefined,
  range: string,
  asOf: Date | undefined,
): string | null {
  // github:/file:/workspace:/npm alias 等 semver でない range は解決不能
  if (!semver.validRange(range, { includePrerelease: true })) return null;

  // asOf 指定時は「その日までに公開された版」だけを候補にする（当時存在しなかった未来版を除外）
  const candidates = asOf && timeMap
    ? versions.filter((v) => {
      if (NON_VERSION_TIME_KEYS.has(v)) return false;
      const published = timeMap[v];
      return published ? new Date(published) <= asOf : false; // 公開日不明の版は候補から外す
    })
    : versions.filter(v => !NON_VERSION_TIME_KEYS.has(v));

  // range を満たす最大版（npm 既定に合わせ prerelease は明示 range 時のみ拾う）
  return semver.maxSatisfying(candidates, range, { includePrerelease: false });
}
