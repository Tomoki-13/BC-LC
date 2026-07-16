import * as t from '@babel/types';
import { extractVariableScopes } from './extractVariableScopes';
import { collectVariableUsageInScopes } from './collectVariableUsageInScopes';
import { VariableUsage } from '../../types/VariableUsage';
import * as parser from '@babel/parser';
import { createAstFromContent } from '../base/createAstFromFile';

//指定された変数のスコープ情報・代入履歴・使用箇所を抽出
export const rangeArg = (
  fileContent: string,
  variableName: string,
): VariableUsage[] => {
  const usages: VariableUsage[] = [];
  const parsed = createAstFromContent(fileContent);

  if (!parsed) {
    return usages;
  }

  //変数のスコープ範囲取得
  const variableScopeRanges = extractVariableScopes(parsed, variableName);
  //スコープ範囲ごとの変数の使用箇所を取得
  // console.log('variableScopeRanges:', variableScopeRanges);
  variableScopeRanges.forEach(element => {
    const usage: string[] = collectVariableUsageInScopes(
      parsed,
      variableName,
      fileContent,
      element
    );
    usages.push({ code: usage, varScopeStart: element.start, varScopeEnd: element.end });
  });
  return usages;
};
