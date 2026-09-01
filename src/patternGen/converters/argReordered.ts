import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns, firstArgDivergence } from './shared';

// detail "(a, b) → (b, a)" から pre/post の引数名列を取る（postSymbol が無い時のフォールバック）
function paramsFromDetail(detail: string | undefined): { pre: string[]; post: string[] } | null {
  const m = /\(([^)]*)\)\s*→\s*\(([^)]*)\)/.exec(detail ?? '');
  if (!m) return null;
  const split = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
  return { pre: split(m[1]), post: split(m[2]) };
}

// 並び替わった位置（pre と post で名前が食い違う位置）。照合時の argContexts 精緻化用
function reorderedIndices(pre: string[], post: string[]): number[] {
  const out: number[] = [];
  const n = Math.max(pre.length, post.length);
  for (let i = 0; i < n; i++) if (pre[i] !== post[i]) out.push(i);
  return out;
}

// arg-reordered: 引数が並び替わった関数の呼び出しを検出
// arity は regex に焼かず argCheck に持たせ、照合時に client の argTypes.length ≥ minArgs で判定
// minArgs = 最初に食い違う位置 +1（そこまで渡した呼び出しで順序が効く）
export const convertArgReordered: TagConverter = (input) => {
  const fromDetail = paramsFromDetail(input.candidate.detail);
  const pre = input.preSymbol.params ?? fromDetail?.pre ?? [];
  const post = input.postSymbol?.params ?? fromDetail?.post ?? [];
  const minArgs = pre.length > 0 ? firstArgDivergence(pre, post) + 1 : 2;
  const changedIndices = reorderedIndices(pre, post);
  return usageCallPatterns(input).map(p => ({ ...p, argCheck: { minArgs, changedIndices } }));
};
