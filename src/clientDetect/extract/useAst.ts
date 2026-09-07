import fsPromises from 'fs/promises';
import { funcNameIdentifiers, secfuncNameIdentifiers } from "../../utils/funcNameIdentifiers";
import { extractImportLines } from "../../utils/extractImportLines";
import { getExportModuleProperty } from '../../astRelated/analyzer/getExportModuleProperty';
import { ExtractFunctionCallsResult } from '../../types/ExtractFunctionCallsResult';
import { analyzeArgAndMethod } from '../../astRelated/analyzer/analyzeArgandMethod';
import { getFileRelated } from '../../astRelated/trace/getFileRelated';
import { OutboundFileDependencies } from '../../types/FileDependencies';
import { InboundFunctionDependencies } from '../../types/FileDependencies';
import { reverseDependencies } from '../../astRelated/trace/reverseDependencies';

// mode 0:使用方法をそのまま, 1:使用方法の一部抽象化でパターンに使いやすく
// クライアントの「ライブラリ使用（import 行＋実際の呼び出し）」を ExtractFunctionCallsResult[][] に抽出する
export const useAst = async (allFiles: string[], libName: string, mode: number = 0): Promise<ExtractFunctionCallsResult[][]> => {
  let pattern: ExtractFunctionCallsResult[][] = [];
  const visitedFiles: Set<string> = new Set<string>();

  let j = 1;

  // BC-LC 追加: どのファイルも libName を import していない repo は抽出対象なし（結果は必ず []）
  let anyImport = false;
  for (const filePath of allFiles) {
    try { if (extractImportLines(await fsPromises.readFile(filePath, 'utf8'), libName).length > 0) { anyImport = true; break; } } catch { /* skip */ }
  }
  if (!anyImport) return [];

  const groupedDependencies: OutboundFileDependencies[] = getFileRelated(allFiles);
  const reversed: InboundFunctionDependencies[] = reverseDependencies(groupedDependencies);

  for (const filePath of allFiles) {
    if (visitedFiles.has(filePath)) continue;
    visitedFiles.add(filePath);

    try {
      const fileContent = await fsPromises.readFile(filePath, 'utf8');
      const lines: string[] = extractImportLines(fileContent, libName);

      let inFileStr: ExtractFunctionCallsResult[] = [];
      if (lines.length > 0) {
        lines.forEach(line => {
          inFileStr.push({
            FunctionCallCode: line,
            filePath: filePath,
            line: 0,
            argTypes: [[]],
            argContexts: [[]]
          });
        });
      }

      let funcName: string[] = [];
      for (const line of lines) {
        let name: string[] = funcNameIdentifiers(line, libName);
        if (name.length > 0) {
          funcName.push(...name);
          for (const one of funcName) {
            const secUseFuncnames = secfuncNameIdentifiers(one, fileContent);
            if (secUseFuncnames.length > 0) {
              funcName.push(...secUseFuncnames);
            }
          }
        }
      }

      if (funcName.length > 0) {
        const uniquefuncName: string[] = [...new Set(funcName)];

        for (const one of uniquefuncName) {
          let result: ExtractFunctionCallsResult[] = await analyzeArgAndMethod(filePath, one, reversed);

          if (result.length > 0) {
            if (mode === 1) {
              const checkstr = 'mock';
              let hasMock = false;
              for (const subresult of result) {
                if (subresult.FunctionCallCode.includes(checkstr)) {
                  hasMock = true;
                  break;
                }
              }
              if (hasMock) return [];

              let except_str = await getExportModuleProperty(filePath, one);
              if (except_str.length > 0) {
                return [];
              }
            }
            inFileStr.push(...result);
          }
        }

        if (inFileStr.length > 0) {
          if (mode === 0) {
            pattern.push(inFileStr);
          } else if (mode === 1) {
            const letregex = /^\s*(?:let|const|var)/;
            const base = "---";

            for (let resIndex = 0; resIndex < inFileStr.length; resIndex++) {
              inFileStr[resIndex].FunctionCallCode = inFileStr[resIndex].FunctionCallCode.replace(letregex, '').trimStart();
            }

            let sortUniquefuncName = uniquefuncName.sort((a, b) => b.length - a.length);

            for (const one of sortUniquefuncName) {
              let replaceString: string = base + j.toString();
              let mainregex = new RegExp(`(?<!["\`'])${one}(?!["\`'])`, 'g');

              for (let resIndex = 0; resIndex < inFileStr.length; resIndex++) {
                let code = inFileStr[resIndex].FunctionCallCode;

                if (/import|require/.test(code) && !/^\s*\/\//.test(code) && /\{.*\}/.test(code)) {
                  let regex1 = new RegExp(`:\\s*(?<!["\`'])${one}(?!["\`'])`, 'g');
                  let regex2 = new RegExp(`as\\s*(?<!["\`'])${one}(?!["\`'])`, 'g');
                  if (regex1.test(code) || regex2.test(code)) {
                    code = code.replace(mainregex, replaceString);
                  }
                } else {
                  code = code.replace(mainregex, replaceString);
                }
                inFileStr[resIndex].FunctionCallCode = code;
              }
              j++;
            }
            pattern.push(inFileStr);
          }
        }
      }
    } catch (err) {
      console.error('Error readFile:', err);
    }
  }

  for (let i = 0; i < pattern.length; i++) {
    for (let resIndex = pattern[i].length - 1; resIndex >= 0; resIndex--) {
      let code = pattern[i][resIndex].FunctionCallCode;

      if (code.length > 400) {
        pattern[i].splice(resIndex, 1);
        continue;
      }

      if (typeof code === 'string') {
        code = code.replace(/[\r\n]/g, '');
        code = code.replace(/^,|,$/g, '');
        if (code.endsWith(';')) {
          code = code.slice(0, -1);
        }
        code = code.trim().replace(/\s+/g, ' ');
      }

      if (code.length === 0) {
        pattern[i].splice(resIndex, 1);
      } else {
        pattern[i][resIndex].FunctionCallCode = code;
      }
    }
  }

  pattern = pattern.filter(subArray => subArray.length > 0);

  if (pattern.length > 0) {
    for (let i = 0; i < pattern.length; i++) {
      for (let resIndex = 0; resIndex < pattern[i].length; resIndex++) {
        let c = pattern[i][resIndex].FunctionCallCode;

        if (typeof c === 'string') {
          c = c.replace(/[\r\n]/g, '');
          c = c.replace(/^,|,$/g, '');
          if (c.endsWith(';')) {
            c = c.slice(0, -1);
          }
          c = c.trim().replace(/\s+/g, ' ');
        }
        pattern[i][resIndex].FunctionCallCode = c;
      }
    }
  }
  return pattern;
}
