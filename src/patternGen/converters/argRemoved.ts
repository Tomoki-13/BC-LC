import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns, firstArgDivergence } from './shared';

// detail "(a, b) → (c)" から pre/post の引数名列を取る（postSymbol が無い時のフォールバック）
function paramsFromDetail(detail: string | undefined): { pre: string[]; post: string[] } | null {
  const m = /\(([^)]*)\)\s*→\s*\(([^)]*)\)/.exec(detail ?? '');
  if (!m) return null;
  const split = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
  return { pre: split(m[1]), post: split(m[2]) };
}

// 削除された pre 位置（post に無い pre のインデックス）。照合時の argContexts 精緻化用
function removedIndices(pre: string[], post: string[]): number[] {
  const out: number[] = [];
  const postSet = new Set(post);
  pre.forEach((p, i) => { if (!postSet.has(p)) out.push(i); });
  return out.length > 0 ? out : (pre.length > post.length ? [post.length] : []);
}

// arg-removed: 引数が減った関数の呼び出しを検出
// arity は regex に焼かず argCheck に持たせ、照合時に client の argTypes.length ≥ minArgs で判定
// minArgs = 最初に食い違う位置 +1（中間削除=シフト位置／末尾削除=new arity）
export const convertArgRemoved: TagConverter = (input) => {
  const fromDetail = paramsFromDetail(input.candidate.detail);
  const pre = input.preSymbol.params ?? fromDetail?.pre ?? [];
  const post = input.postSymbol?.params ?? fromDetail?.post ?? [];
  const minArgs = pre.length > 0 ? firstArgDivergence(pre, post) + 1 : 1;
  const changedIndices = removedIndices(pre, post);
  return usageCallPatterns(input).map(p => ({ ...p, argCheck: { minArgs, changedIndices } }));
};
