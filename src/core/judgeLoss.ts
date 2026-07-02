import type { LossCandidate } from '../types/LibDiff';

function judge(candidates: LossCandidate[]): LossCandidate[] {
  // TODO: ルール適用・重みづけ。現状は候補をそのまま返す
  return candidates;
}

export default {
  judge,
};
