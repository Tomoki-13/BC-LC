import traverse from '@babel/traverse';
import * as t from '@babel/types';

// 指定された変数名に対応するスコープ範囲（複数ある場合も）を抽出
// 入力するparsedは、@babel/parserでパースしたスコープ範囲内のデータを想定
//jsとtsで処理を変えることも検討
// TODO: デフォルト値の処理で定義されているものを考慮しない方針
export const collectVariableUsageInScopes = (
  parsed: t.File,
  variableName: string,
  fileContent: string,
  scopeRange?: { start: number; end: number }
): string[] => {
  const usages: string[] = [];
  // 変数への代入履歴を取得
  traverse(parsed, {
    VariableDeclarator(path) {
      if (scopeRange) {
        if (typeof path.node.start === 'number' && typeof path.node.end === 'number') {
           // ノードが指定範囲の外にある場合はスキップ
           if (path.node.start < scopeRange.start || path.node.end > scopeRange.end) {
             return;
           }
        }
      }

      const { id, init } = path.node;
      if (
        t.isIdentifier(id) &&
        id.name === variableName &&
        init &&
        typeof init.start === 'number' &&
        typeof init.end === 'number'
      ) {
        const rhs = fileContent.substring(init.start, init.end);
        usages.push(rhs);
      }
    },

    AssignmentExpression(path) {
      if (scopeRange) {
        if (typeof path.node.start === 'number' && typeof path.node.end === 'number') {
           if (path.node.start < scopeRange.start || path.node.end > scopeRange.end) {
             return;
           }
        }
      }
      
      const { left, right, operator } = path.node;
      if (
        t.isIdentifier(left) &&
        left.name === variableName &&
        typeof right.start === 'number' &&
        typeof right.end === 'number'
      ) {
        const rhsCode = fileContent.substring(right.start, right.end);
        // +=, -= などは a = a + 1 のように展開する
        const opMap: Record<string, string> = {
          '+=': '+',
          '-=': '-',
          '*=': '*',
          '/=': '/',
          '%=': '%'
        };
        const expandedRhs = opMap[operator]
          ? `${variableName} ${opMap[operator]} ${rhsCode}`
          : rhsCode;
        usages.push(expandedRhs);
      }
    },
  });

  return usages;
};