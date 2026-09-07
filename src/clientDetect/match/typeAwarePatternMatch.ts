import patternConversion from "./patternConversion";
import { ExtractFunctionCallsResult } from "../types/ExtractFunctionCallsResult";

/**
 * 型情報を考慮したパターンマッチング関数。
 *
 * ### mode 定義
 * - **mode 0**: コードのみ（型情報を無視）
 * - **mode 1**: コード + 型の完全一致
 *   - argTypes の配列を文字列化して厳密比較
 *   - "object" は "object" とのみ一致（キー情報は無視）
 * - **mode 2**: コード + 型一致 + object キー部分一致
 *   - "object:{key1,key2}" のパターンに対し、ターゲットが同じキーを全て持てばマッチ
 *   - 旧形式 "object"（キー情報なし）とは双方向で後方互換マッチ
 *   - 検出数の変化を mode 1 と比較することで、キー情報がどれだけ精度を上げるかを測定できる
 * - **mode 3**: （将来実装）コード + 型一致 + object キー名 + 値の型まで確認
 *   - 例: "object:{caseFirst:boolean}" のようにプロパティの値型も比較
 * - **mode 4**: （将来実装）コード + 型一致 + object キー名 + 実際の値まで確認
 *   - 例: "object:{caseFirst:true}" のように実際の値まで比較
 *
 * @param {ExtractFunctionCallsResult[][]} detectionTargets 解析済みのソースコードデータ (ファイル単位の配列の配列)
 * @param {ExtractFunctionCallsResult[][][]} detectionPatterns 検出に用いるパターンのリスト
 * @param {number} mode マッチングモード（デフォルト: 1）
 * @returns {Promise<[boolean, ExtractFunctionCallsResult[][] | null]>}
 */
export const typeAwarePatternMatch = async (
  detectionTargets: ExtractFunctionCallsResult[][],
  detectionPatterns: ExtractFunctionCallsResult[][][],
  mode: number = 1
): Promise<[boolean, ExtractFunctionCallsResult[][] | null]> => {
  let searchCandidates: ExtractFunctionCallsResult[][][] = JSON.parse(JSON.stringify(detectionPatterns));

  try {
    for (const currentPattern of searchCandidates) {

      const patternVariables: {
        [key: string]: {
          code: string,
          types: string[][],
          context: string[][]
        }[]
      } = {};

      for (const blockGroup of currentPattern) {
        for (const block of blockGroup) {
          const str = block.FunctionCallCode;
          const match = str.match(/variable(\d+)/g);

          if (match) {
            const varKey = match[0];
            if (!patternVariables[varKey]) {
              patternVariables[varKey] = [];
            }
            patternVariables[varKey].push({
              code: str,
              types: block.argTypes || [],
              context: block.argContexts || []
            });
          }
        }
      }

      const foundVariablesStatus: { [key: string]: boolean } = {};
      const variableKeys = Object.keys(patternVariables);
      variableKeys.forEach(key => foundVariablesStatus[key] = false);

      for (const fileDataBlocks of detectionTargets) {

        if (Object.values(foundVariablesStatus).every(status => status === true)) {
          return [true, currentPattern];
        }

        const flatFileData = fileDataBlocks.map(block => ({
          code: block.FunctionCallCode,
          types: block.argTypes || [],
          context: block.argContexts || []
        }));

        const patternVariablesInFile = JSON.parse(JSON.stringify(patternVariables));

        for (const key of variableKeys) {
          if (foundVariablesStatus[key]) {
            continue;
          }

          const defCode = patternVariablesInFile[key][0].code;

          let patternRegexStr = patternConversion.escapeFunc(defCode);

          if (!patternRegexStr.includes(`(?<${key}>`)) {
            patternRegexStr = patternRegexStr.replace(new RegExp(key, 'g'), `(?<${key}>[\\w$]+)`);
          }

          const regexDef = new RegExp(patternRegexStr);

          let definitionMatch: RegExpMatchArray | null = null;
          let definitionIndex: number = 0;

          for (let i = 0; i < flatFileData.length; i++) {
            definitionMatch = flatFileData[i].code.match(regexDef);
            definitionIndex = i + 1;
            if (definitionMatch) break;
          }

          if (definitionMatch && definitionMatch.groups) {
            const actualVarName = definitionMatch.groups[key];

            for (const otherKey in patternVariablesInFile) {
              for (let i = 0; i < patternVariablesInFile[otherKey].length; i++) {
                if (!(otherKey === key && i === 0)) {
                  patternVariablesInFile[otherKey][i].code =
                    patternVariablesInFile[otherKey][i].code.replace(key, actualVarName);
                }
              }
            }

            if (patternVariablesInFile[key].length === 1) {
              foundVariablesStatus[key] = true;
              continue;
            }

            let allUsagesMatched = false;

            for (let i = 1; i < patternVariablesInFile[key].length; i++) {
              let usagePatternCode = patternVariablesInFile[key][i].code;
              const usageRegex = new RegExp(patternConversion.escapeFunc(usagePatternCode));
              let matched = false;
              
              for (let j = definitionIndex; j < flatFileData.length; j++) {
                const userData = flatFileData[j];

                let normalizedCode = userData.code.replace(/[\r\n]/g, '');
                normalizedCode = normalizedCode.replace(/\[[^\]]*\]/g, 'argument');
                normalizedCode = normalizedCode.replace(/\{[^}]*\}/g, 'argument');

                const usageMatch = normalizedCode.match(usageRegex);

                if (usageMatch) {
                  let isMatchValid = true;

                  if (mode >= 1) {
                    const userTypes = userData.types;
                    const expectedTypes = patternVariablesInFile[key][i].types;

                    if (userTypes.length !== expectedTypes.length) {
                      isMatchValid = false;
                    } else {
                      for (let k = 0; k < expectedTypes.length; k++) {
                        // LOOK: unknown を除外してから比較（filterUnknown 方式）
                        //   filterUnknown(['string','unknown']) → ['string']  既知型のみで比較
                        //   filterUnknown(['unknown'])          → []          空 = 完全 wildcard（スキップ）
                        // どちらかが空なら型解析不十分とみなしその引数位置をスキップ
                        // e.g. ['string','unknown'] vs ['number'] → ['string'] vs ['number'] → 不一致
                        //      ['unknown']          vs ['number'] → []         vs ['number'] → スキップ
                        const filteredExpected = expectedTypes[k].filter((t: string) => t !== 'unknown');
                        const filteredUser = userTypes[k].filter((t: string) => t !== 'unknown');
                        if (filteredExpected.length > 0 && filteredUser.length > 0) {
                          if (mode >= 2) {
                            // mode 2以上: object:{key} 形式のキー部分一致を含む高度な型マッチング
                            // 旧形式 "object" との後方互換も保持
                            const allExpectedCovered = filteredExpected.every((et: string) =>
                              filteredUser.some((ut: string) => isTypeMatch(et, ut))
                            );
                            if (!allExpectedCovered) {
                              isMatchValid = false;
                              break;
                            }
                          } else {
                            // mode 1: object:{...} はキー情報を捨てて 'object' に正規化してから比較
                            // キー解析が実装される前の挙動を再現する
                            const normalize = (t: string) => t.startsWith('object') ? 'object' : t;
                            const uT = filteredUser.map(normalize).sort().join(',');
                            const eT = filteredExpected.map(normalize).sort().join(',');
                            if (uT !== eT) {
                              isMatchValid = false;
                              break;
                            }
                          }
                        }
                      }
                    }

                    if (isMatchValid && mode >= 3) {
                      // mode 3以上: object:{key:valueType} 形式での値型マッチング（将来実装）
                      // 例: "object:{caseFirst:boolean}" と "object:{caseFirst:boolean,locale:string}" を比較
                    }
                  }

                  if (isMatchValid) {
                    matched = true;
                    break;
                  }
                }
              }

              if (!matched) {
                allUsagesMatched = false;
                break;
              }

              if (i === patternVariablesInFile[key].length - 1) {
                allUsagesMatched = true;
              }
            }

            if (allUsagesMatched) {
              foundVariablesStatus[key] = true;
            }
          }
        }
      }

      if (Object.values(foundVariablesStatus).every(status => status === true)) {
        return [true, currentPattern];
      }
    }
  } catch (err) {
    console.error('Error typeAwarePatternMatch:', err);
  }
  return [false, null];
};

/**
 * "object:{key1,key2,...}" 形式の型文字列からキー名の配列を抽出する。
 * @param type 型文字列（例: "object:{caseFirst,sensitivity}"）
 * @returns キー名の配列（例: ["caseFirst", "sensitivity"]）
 */
function extractObjectTypeKeys(type: string): string[] {
  const match = type.match(/^object:\{(.*)\}$/);
  if (!match || !match[1]) return [];
  return match[1].split(',').filter(k => k.length > 0);
}

/**
 * 2つの型文字列が「マッチする」かを判定する。
 * - 完全一致は常にマッチ
 * - 旧形式 "object" はすべての object 系とマッチ（後方互換）
 * - "object:{...}" 同士はパターンのキーがターゲットに全て含まれる場合にマッチ（キー部分一致）
 * @param patternType パターン側の型文字列
 * @param targetType ターゲット側の型文字列
 */
function isTypeMatch(patternType: string, targetType: string): boolean {
  // 完全一致
  if (patternType === targetType) return true;

  // 旧形式 "object" との後方互換: どちらかが "object" ならもう一方が object 系であればマッチ
  if (patternType === 'object' && targetType.startsWith('object')) return true;
  if (targetType === 'object' && patternType.startsWith('object')) return true;

  // 両方 object:{...} 形式: パターンのキーが全てターゲットに含まれる場合にマッチ
  // 例: pattern="object:{caseFirst}" は target="object:{caseFirst,sensitivity}" にマッチする
  if (patternType.startsWith('object:{') && targetType.startsWith('object:{')) {
    const patternKeys = extractObjectTypeKeys(patternType);
    const targetKeys = extractObjectTypeKeys(targetType);
    return patternKeys.every(k => targetKeys.includes(k));
  }

  return false;
}