import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns, firstArgDivergence } from './shared';

// detail "(a, b) → (b, a)" から pre/post の引数名列を取る（postSymbol が無い時のフォールバック）
function paramsFromDetail(detail: string | undefined): { pre: string[]; post: string[] } | null {
  const m = /\(([^)]*)\)\s*→\s*\(([^)]*)\)/.exec(detail ?? '');
  if (!m) return null;
  const split = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
  return { pre: split(m[1]), post: split(m[2]) };
}

// arg-reordered: 引数が並び替わった関数の呼び出しを検出
// 順序が効くのは最初に食い違う位置 i まで渡した呼び出し（最低 i+1 個）
export const convertArgReordered: TagConverter = (input) => {
  const fromDetail = paramsFromDetail(input.candidate.detail);
  const pre = input.preSymbol.params ?? fromDetail?.pre ?? [];
  const post = input.postSymbol?.params ?? fromDetail?.post ?? [];
  const minArgs = pre.length > 0 ? firstArgDivergence(pre, post) + 1 : 2;
  return usageCallPatterns(input, minArgs);
};
