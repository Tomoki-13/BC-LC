import { promises as fsPromises } from 'fs';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { FunctionInfo_funcRange } from '../../types/FunctionInfo';
import { getBasicFunctionInfo} from '../trace/getFunction';
import { rangeArg } from '../scope/rangeArg';
import { InboundFunctionDependencies } from '../../types/FileDependencies';
import { VariableUsage } from '../../types/VariableUsage';
import { ExtractFunctionCallsResult } from '../../types/ExtractFunctionCallsResult';
import { createAstFromFile } from '../base/createAstFromFile';

// 引数まで考慮した関数呼び出しの解析
// TODO: 関数定義箇所も検出対象(一旦テストはfailさせておく)
export const analyzeArgAndMethod = async (
  filePath: string,
  funcName: string,
  funcDepend: InboundFunctionDependencies[],
): Promise<ExtractFunctionCallsResult[]> => {
  try {
    const syncResults: ExtractFunctionCallsResult[] = [];
    const promises: Promise<ExtractFunctionCallsResult | null>[] = [];

    if (
      !filePath.endsWith('.js') &&
      !filePath.endsWith('.ts') &&
      !filePath.endsWith('.jsx') &&
      !filePath.endsWith('.tsx')
    ) {
      return [];
    }

    const fileContent: string = await fsPromises.readFile(filePath, 'utf8');
    const parsed = createAstFromFile(filePath, fileContent);
    if (parsed === null) {
      return [];
    }
    const allFunctions: FunctionInfo_funcRange[] = await getBasicFunctionInfo(filePath, 1);

    traverse(parsed, {
      VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
        const declarationNode = path.findParent(
          (p): p is NodePath<t.VariableDeclaration> =>
            p.isVariableDeclaration(),
        );
        if (!declarationNode) return;

        const initNode = path.node.init;
        if (!initNode) return;

        if (
          t.isCallExpression(initNode) &&
          t.isIdentifier(initNode.callee) &&
          initNode.callee.name === '_interopRequireDefault'
        ) {
          const init = initNode;
          if (
            init.arguments &&
            init.arguments.some((arg) => {
              if (
                t.isIdentifier(arg) &&
                new RegExp(`^${funcName}(?![a-zA-Z])`).test(arg.name)
              ) {
                return true;
              }
              return false;
            })
          ) {
            if (
              declarationNode.node.start != null &&
              declarationNode.node.end != null
            ) {
              const code: string = fileContent.substring(
                declarationNode.node.start,
                declarationNode.node.end,
              );
              syncResults.push({
                FunctionCallCode: code,
                filePath: filePath,
                line: declarationNode.node.loc ? declarationNode.node.loc.start.line : 0,
                argTypes: [[]],
                argContexts: [[]],
              });
            }
          }
        } else if (
          t.isMemberExpression(initNode) &&
          t.isIdentifier(initNode.object, { name: funcName }) &&
          t.isIdentifier(initNode.property, { name: 'default' })
        ) {
          if (
            declarationNode.node.start != null &&
            declarationNode.node.end != null
          ) {
            const code = fileContent.substring(
              declarationNode.node.start,
              declarationNode.node.end,
            );
            syncResults.push({
              FunctionCallCode: code,
              filePath: filePath,
              line: declarationNode.node.loc ? declarationNode.node.loc.start.line : 0,
              argTypes: [[]],
              argContexts: [[]],
            });
          }
        }
      },

      CallExpression(path: NodePath<t.CallExpression>) {
        const processCall = async (): Promise<ExtractFunctionCallsResult | null> => {
          if (path.node.start == null || path.node.end == null) {
            return null;
          }

          const callee = path.node.callee;
          let isTargetFound = false;
          if (t.isIdentifier(callee) && new RegExp(`^${funcName}(?![a-zA-Z])`).test(callee.name)) {
            isTargetFound = true;
          } else if (t.isMemberExpression(callee)) {
            let current: t.Expression | t.V8IntrinsicIdentifier = callee.object;
            while (t.isMemberExpression(current)) {
              current = current.object;
            }
            if (t.isIdentifier(current) && new RegExp(`^${funcName}(?![a-zA-Z])`).test(current.name)) {
              isTargetFound = true;
            }
          }

          if (isTargetFound) {
            const code: string = fileContent.substring(path.node.start, path.node.end);
            const { finalArgTypes, finalArgContexts } = await analyzeArguments(
              path.node.arguments,
              fileContent,
              allFunctions,
              funcDepend,
            );

            const dedupedArgTypes = finalArgTypes.map((types) => [
              ...new Set(types),
            ]);
            const dedupedArgContexts = finalArgContexts.map((contexts) => [
              ...new Set(contexts),
            ]);
            return {
              FunctionCallCode: code,
              filePath: filePath,
              line: path.node.loc ? path.node.loc.start.line : 0,
              argTypes: dedupedArgTypes,
              argContexts: dedupedArgContexts,
            };
          }
          return null;
        };
        promises.push(processCall());
      },

      NewExpression(path: NodePath<t.NewExpression>) {
        const processNew = async (): Promise<ExtractFunctionCallsResult | null> => {
          if (path.node.start == null || path.node.end == null) {
            return null;
          }

          const callee = path.node.callee;
          if (
            t.isIdentifier(callee) &&
            new RegExp(`^${funcName}(?![a-zA-Z])`).test(callee.name)
          ) {
            const code: string = fileContent.substring(
              path.node.start,
              path.node.end,
            );
            const { finalArgTypes, finalArgContexts } =
              await analyzeArguments(
                path.node.arguments,
                fileContent,
                allFunctions,
                funcDepend,
              );

            const dedupedArgTypes = finalArgTypes.map((types) => [
              ...new Set(types),
            ]);
            const dedupedArgContexts = finalArgContexts.map((contexts) => [
              ...new Set(contexts),
            ]);
            return {
              FunctionCallCode: code,
              filePath: filePath,
              line: path.node.loc ? path.node.loc.start.line : 0,
              argTypes: dedupedArgTypes,
              argContexts: dedupedArgContexts,
            };
          }
          return null;
        };
        promises.push(processNew());
      },
    });

    const asyncResults = await Promise.all(promises);
    const validAsyncResults = asyncResults.filter(
      (result): result is ExtractFunctionCallsResult => result !== null,
    );

    return syncResults.concat(validAsyncResults);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error('An unknown error occurred', error);
    }
    return [];
  }
};

/**
 * 引数を解析し、その型とコンテキストを特定する関数
 * @param args 解析対象の引数ノードの配列
 * @param fileContent ファイルの全コンテンツ
 * @param allFunctions ファイル内の全関数情報
 * @param funcDepend 逆引きされた依存関係情報
 * @returns 引数の型とコンテキストの解析結果
 */
async function analyzeArguments(
  args: (t.Expression | t.SpreadElement | t.JSXNamespacedName | t.ArgumentPlaceholder)[],
  fileContent: string,
  allFunctions: FunctionInfo_funcRange[],
  funcDepend: InboundFunctionDependencies[],
): Promise<{ finalArgTypes: string[][]; finalArgContexts: string[][] }> {
  const finalArgTypes: string[][] = Array.from(
    { length: args.length },
    () => [],
  );
  const finalArgContexts: string[][] = Array.from(
    { length: args.length },
    () => [],
  );

  for (const [index, arg] of args.entries()) {
    if (
      !arg ||
      !('start' in arg && 'end' in arg &&
        arg.start !== null && arg.end !== null
      )
    )
      continue;

    // 引数が「変数名（識別子）」の場合
    if (t.isIdentifier(arg)) {
      const usages: VariableUsage[] = rangeArg(fileContent, arg.name);
      let isUserFuncArg = false;
      const relatedFuncs = new Set<string>();

      for (const usage of usages) {
        for (const func of allFunctions) {
          if (
            func.arg.includes(arg.name) &&
            typeof func.start === 'number' &&
            typeof func.end === 'number' &&
            usage.varScopeStart !== undefined &&
            usage.varScopeEnd !== undefined &&
            func.start <= usage.varScopeStart &&
            func.end >= usage.varScopeEnd
          ) {
            if (
              arg.start !== undefined &&
              arg.end !== undefined &&
              arg.start >= func.start &&
              arg.end <= func.end
            ) {
              isUserFuncArg = true;
              relatedFuncs.add(func.funcname);
            }
          }
        }
      }
      // 親関数から渡された引数だった場合
      if (isUserFuncArg) {
        for (const one of relatedFuncs) {
          const outerFuncDef = allFunctions.find((f) => f.funcname === one);
          const outerArgIndex = outerFuncDef ?
            outerFuncDef.arg.indexOf(arg.name) :
            -1;
          if (outerArgIndex === -1) continue;

          const filterData = funcDepend.filter(
            (item) => item.funcNameInFilepath === one,
          );
          for (const checker of filterData) {
            for (const outFileDep of checker.dependence) {
              const recursiveResult = await analyzeArgAndMethod(
                outFileDep.dep_filepath,
                one,
                funcDepend,
              );
              for (const recResult of recursiveResult) {
                const typesFromRec = recResult.argTypes?.[outerArgIndex] || [];
                const contextsFromRec =
                  recResult.argContexts?.[outerArgIndex] || [];
                
                finalArgTypes[index].push(...typesFromRec);
                finalArgContexts[index].push(
                   ...contextsFromRec.map(cleanCodeSnippet)
                );
              }
            }
          }
        }
      }
      // 変数追跡の結果、関数引数以外の場合
      const argType_tmp: string[] = [];
      const argContexts_tmp: string[] = [];
      for (const usageItem of usages) {
        for (const codeSnippet of usageItem.code) {
          argType_tmp.push(inferTypeFromCode(codeSnippet));
          argContexts_tmp.push(cleanCodeSnippet(codeSnippet));
        }
      }
      finalArgTypes[index].push(...argType_tmp);
      finalArgContexts[index].push(...argContexts_tmp);

      if (finalArgTypes[index].length === 0) {
        if (arg.start !== undefined && arg.end !== undefined) {
          const snippet = fileContent.substring(arg.start, arg.end);
          finalArgTypes[index].push('unknown');
          finalArgContexts[index].push(cleanCodeSnippet(snippet));
        }
      }

    } else {
      // 識別子以外（リテラルや式など）の処理
      if (arg.start !== undefined && arg.end !== undefined) {
        const snippet = fileContent.substring(arg.start, arg.end);
        finalArgTypes[index].push(inferTypeFromCode(snippet));
        finalArgContexts[index].push(cleanCodeSnippet(snippet));
      } else {
        console.warn('arg.start or arg.end is undefined');
      }
    }
  }
  return { finalArgTypes, finalArgContexts };
}

/**
 * コードスニペットから簡易的な型推論を行う
 * * @param code 評価するコードの文字列
 * @returns 推論された型名
 */
function inferTypeFromCode(
  code: string,
): 'number' | 'string' | 'boolean' | 'null' | 'undefined' | 'array' | 'object' | 'function' | 'unknown' {
  const cleanCode = cleanCodeSnippet(code);

  if (/^-?\d+(\.\d+)?$/.test(cleanCode)) return 'number';
  if (/^(['"]).*\1$/.test(cleanCode)) return 'string';
  if (/^`.*`$/s.test(cleanCode)) return 'string';
  if (cleanCode === 'true' || cleanCode === 'false') return 'boolean';
  if (cleanCode === 'null') return 'null';
  if (cleanCode === 'undefined') return 'undefined';
  
  if (/^(\(.*\)|[^=\s]+)\s*=>/.test(cleanCode)) return 'function';
  if (/^function\s*\(/.test(cleanCode)) return 'function';

  if (/^\[.*\]$/s.test(cleanCode)) return 'array';
  if (/^\{.*\}$/s.test(cleanCode)) return 'object';
  if (/^new\s+/.test(cleanCode)) return 'object';
  if (/^[\w$]+\.(assign|create|fromEntries|merge|keys|values)\b/.test(cleanCode)) return 'object';

  if (/(===|!==|==|!=|<=|>=|<|>)/.test(cleanCode) && !/=>/.test(cleanCode)) {
    return 'boolean';
  }
  if (/[\+\-\*\/%]/.test(cleanCode) && !/['"`]/.test(cleanCode)) return 'number';

  return 'unknown';
}

// コードからコメント(//, /* */)や改行、不要な空白を除去する関数を追加
function cleanCodeSnippet(code: string): string {
  let cleaned = code.replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.replace(/\/\/.*$/gm, '');
  cleaned = cleaned.replace(/[\n\r\t]/g, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}