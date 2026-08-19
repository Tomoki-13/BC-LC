import { LossCandidate, LOSS_TAGS } from '../types/LibDiff';

/**
 * 機能1(v1): diffSurface の候補のうち損失タグ(LOSS_TAGS)だけを verdict='loss' で確定する
 *   確実(structural) / 要確認(semantic) の区別は confidence 側に残す（semantic も loss として数える）
 */
function judge(candidates: LossCandidate[]): LossCandidate[] {
  // LOOK: 損失として数えるのは LOSS_TAGS のみ。他タグ(option-added/arg-added/arg-removed 等)は記録として残すが loss にしない
  return candidates.map(c => (LOSS_TAGS.has(c.tag) ? { ...c, verdict: 'loss' as const } : c));
}

export default {
  judge,
};
