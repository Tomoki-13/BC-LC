import semver from 'semver';
import type { DepChange } from '../utils/evalShared';

// npm registry の1バージョンメタ（packument.versions[v]）から見る依存フィールド
interface VersionMeta {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const DEP_KINDS: DepChange['kind'][] = ['dependencies', 'peerDependencies'];

// semver でない range（github:/file:/workspace:/npm alias 等）で throw させず null を返す
const safeMinVersion = (range: string) => { try { return semver.minVersion(range); } catch { return null; } };

/** range 変化を分類（下限 major が上がれば major-bump / それ以外は minor-patch-bump） */
function classifyBump(preRange: string, postRange: string): 'major-bump' | 'minor-patch-bump' {
  const preMin = safeMinVersion(preRange);
  const postMin = safeMinVersion(postRange);
  if (preMin && postMin && postMin.major > preMin.major) return 'major-bump';
  return 'minor-patch-bump';
}

/**
 * 1つの依存種別について pre→post の range 変化を DepChange[] に起こす
 *   追加/削除/major-bump/minor-patch-bump を検出（range 不変は無視）
 */
function diffOneKind(kind: DepChange['kind'], pre: Record<string, string>, post: Record<string, string>): DepChange[] {
  const changes: DepChange[] = [];
  for (const name of new Set([...Object.keys(pre), ...Object.keys(post)])) {
    const preRange = pre[name];
    const postRange = post[name];
    if (preRange && !postRange) {
      changes.push({ name, kind, preRange, change: 'removed' });
    } else if (!preRange && postRange) {
      changes.push({ name, kind, postRange, change: 'added' });
    } else if (preRange && postRange && preRange !== postRange) {
      changes.push({ name, kind, preRange, postRange, change: classifyBump(preRange, postRange) });
    }
  }
  return changes;
}

/**
 * pre/post のバージョンメタから依存(dependencies + peerDependencies)の range 変化を集める
 *   入力: pre/post の VersionMeta（どちらか無ければ空） / 出力: DepChange[]
 */
export function diffDeps(preMeta: VersionMeta | undefined, postMeta: VersionMeta | undefined): DepChange[] {
  if (!preMeta || !postMeta) return [];
  const changes: DepChange[] = [];
  for (const kind of DEP_KINDS) {
    changes.push(...diffOneKind(kind, preMeta[kind] ?? {}, postMeta[kind] ?? {}));
  }
  return changes;
}
