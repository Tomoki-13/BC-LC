import type { LossCandidate } from '../types/LibDiff';

// 機能1(v1): diffSurface が出す候補はすべて後方互換性の損失なので verdict='loss' で確定する。
//   確実(structural) / 要確認(semantic) の区別は confidence 側に残す（semantic も loss として数える）
// TODO: BC 損失ルールの精緻化・クライアント利用実態(phase2)による重みづけ・優先度付け
function judge(candidates: LossCandidate[]): LossCandidate[] {
  return candidates.map(c => ({ ...c, verdict: 'loss' as const }));
}

export default {
  judge,
};
