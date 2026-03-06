import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { ScopeRange } from '../../types/VariableUsage';


//変数(variableName)が定義されたすべてのスコープの範囲（start〜end）を取得
//parsedは全体のAST
export const extractVariableScopes = (
  parsed: t.File,
  variableName: string,
): ScopeRange[] => {
  const variableScopeRanges: ScopeRange[] = [];

  traverse(parsed, {
    enter(path) {
      const binding = path.scope.getBinding(variableName);
      if (
        binding &&
        binding.identifier &&
        typeof binding.scope.block.start === 'number' &&
        typeof binding.scope.block.end === 'number'
      ) {
        const { start, end } = binding.scope.block;
        if (!variableScopeRanges.find(r => r.start === start && r.end === end)) {
          variableScopeRanges.push({ start, end });
        }
      }
    }
  });

  return variableScopeRanges;
};