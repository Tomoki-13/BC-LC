// getFunction.ts
import { promises as fs } from 'fs';
import traverse from '@babel/traverse';
import * as t from '@babel/types';

import { createAstFromFile } from '../base/createAstFromFile';
import { FunctionMetaInfo, FunctionInfo_funcRange } from '../../types/FunctionInfo';

export interface ExtendedFunctionMetaInfo extends FunctionMetaInfo {
  isPropertyFunction?: boolean;
  propertyPath?: string;
  isInstanceMethod?: boolean;
  prototypeObj?: string;
  isPotentialPrototype?: boolean;
  returnExprs?: string[];
}

export const getFunction = async (filePath: string, mode = 0): Promise<ExtendedFunctionMetaInfo[]> => {
  const resultArray: ExtendedFunctionMetaInfo[] = [];
  const explicitlyExportedNames = new Set<string>();
  const exportedFunctions = new Set<string>();

  try {
    if (!filePath.match(/\.(js|ts|jsx|tsx)$/)) return [];

    const fileContent: string = await fs.readFile(filePath, 'utf8');

    if (isObfuscated(fileContent)) {
      console.log(`File ${filePath} is detected as obfuscated. Skipping function extraction.`);
      return [];
    }
    
    const parsed = createAstFromFile(filePath, fileContent);

    if (!parsed) {
      console.log(`getFunc Failed to create AST via helper for file: ${filePath}`);
      return [];
    }

    const serializeFunction = (name: string, args: string[]): string => JSON.stringify({ name, args });

    const getParams = (params: any[]) => params.map((param) => {
      if (t.isIdentifier(param)) return param.name;
      if (param.start != null && param.end != null) {
        return fileContent.substring(param.start, param.end).replace(/\s+/g, ' ').trim();
      }
      return '';
    });

    traverse(parsed, {
      // 通常の関数宣言
      FunctionDeclaration(path) {
        if (path.node.id) {
          const name = path.node.id.name;
          const params = getParams(path.node.params);
          if (!resultArray.some((func) => func.name === name)) {
            resultArray.push({
              name,
              isExported: exportedFunctions.has(serializeFunction(name, params)),
              arg: params,
              filePath,
              start: path.node.start,
              end: path.node.end,
            });
          }
        }
      },

      // ESM: 名前付きエクスポート (export function / export const)
      ExportNamedDeclaration(path) {
        if (path.node.declaration) {
          if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
            const name = path.node.declaration.id.name;
            const params = getParams(path.node.declaration.params);
            exportedFunctions.add(serializeFunction(name, params));
            if (!resultArray.some((func) => func.name === name)) {
              resultArray.push({ name, isExported: true, arg: params, filePath, start: path.node.declaration.start, end: path.node.declaration.end });
            }
          } else if (t.isVariableDeclaration(path.node.declaration)) {
            for (const declarator of path.node.declaration.declarations) {
              if (t.isVariableDeclarator(declarator) && t.isIdentifier(declarator.id) && declarator.init &&
                  (t.isFunctionExpression(declarator.init) || t.isArrowFunctionExpression(declarator.init))) {
                const name = declarator.id.name;
                const params = getParams(declarator.init.params);
                exportedFunctions.add(serializeFunction(name, params));
                if (!resultArray.some((func) => func.name === name)) {
                  resultArray.push({ name, isExported: true, arg: params, filePath, start: declarator.init.start, end: declarator.init.end });
                }
              }
            }
          }
        }
        // export { a, b as c } のエイリアスや遅延エクスポートの追跡
        if (path.node.specifiers) {
          path.node.specifiers.forEach((spec) => {
            if (t.isExportSpecifier(spec) && t.isIdentifier(spec.local)) {
              explicitlyExportedNames.add(spec.local.name);
            }
          });
        }
      },

      // ESM: デフォルトエクスポート (export default)
      ExportDefaultDeclaration(path) {
        if (t.isFunctionDeclaration(path.node.declaration) && path.node.declaration.id) {
          const name = path.node.declaration.id.name;
          const params = getParams(path.node.declaration.params);
          exportedFunctions.add(serializeFunction(name, params));
          if (!resultArray.some((func) => func.name === name)) {
            resultArray.push({ name, isExported: true, arg: params, filePath, start: path.node.declaration.start, end: path.node.declaration.end });
          }
        } else if (t.isIdentifier(path.node.declaration)) {
          explicitlyExportedNames.add(path.node.declaration.name);
        }
      },

      // 変数への関数代入 (const a = () => {})
      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.id) && path.node.init && (t.isFunctionExpression(path.node.init) || t.isArrowFunctionExpression(path.node.init))) {
          const name = path.node.id.name;
          const params = getParams(path.node.init.params);
          if (!resultArray.some((func) => func.name === name)) {
            resultArray.push({
              name,
              isExported: exportedFunctions.has(serializeFunction(name, params)),
              arg: params,
              filePath,
              start: path.node.init.start,
              end: path.node.init.end,
            });
          }
        }
      },

      // CommonJS / 代入式ベースのエクスポート
      AssignmentExpression(path) {
        const left = path.node.left;
        const right = path.node.right;

        // module.exports = { a: funcA, b: { c: funcC } } のネスト解析
        if (t.isObjectExpression(right)) {
          const isModuleExports = 
            (t.isIdentifier(left) && left.name === 'exports') ||
            (t.isMemberExpression(left) && t.isIdentifier(left.object, { name: 'module' }) && t.isIdentifier(left.property, { name: 'exports' }));

          if (isModuleExports) {
            const collectExportedNames = (properties: any[]) => {
              properties.forEach((prop) => {
                if (t.isObjectProperty(prop)) {
                  if (t.isIdentifier(prop.value)) {
                    explicitlyExportedNames.add(prop.value.name);
                  } else if (t.isObjectExpression(prop.value)) {
                    collectExportedNames(prop.value.properties);
                  }
                }
              });
            };
            collectExportedNames(right.properties);
          }
        }

        // module.exports.func = function() {}
        if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
          let name: string | undefined;
          const params = getParams(right.params);

          if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.property)) {
            const object = left.object;
            if ((t.isIdentifier(object, { name: 'exports' })) || 
                (t.isMemberExpression(object) && t.isIdentifier(object.object, { name: 'module' }) && t.isIdentifier(object.property, { name: 'exports' }))) {
              name = left.property.name;
              exportedFunctions.add(serializeFunction(name, params));
            }
          } else if (t.isIdentifier(left)) {
            name = left.name;
          }

          if (name && !resultArray.some((func) => func.name === name)) {
            resultArray.push({
              name,
              isExported: true,
              arg: params,
              filePath,
              start: right.start,
              end: right.end,
            });
          }
        }
      },

      // クラスメソッド
      ClassMethod(path) {
        if (t.isIdentifier(path.node.key)) {
          const name = path.node.key.name;
          const params = getParams(path.node.params);
          const parentClass = path.findParent((p) => p.isClassDeclaration());
          let isExported = false;

          if (parentClass && (t.isExportNamedDeclaration(parentClass.parent) || t.isExportDefaultDeclaration(parentClass.parent))) {
            isExported = true;
          }
          if (!resultArray.some((func) => func.name === name)) {
            resultArray.push({ name, isExported, arg: params, filePath, start: path.node.start, end: path.node.end });
          }
        }
      },

      // クラスプロパティへのアロー関数代入
      ClassProperty(path) {
        if (t.isIdentifier(path.node.key) && path.node.value && (t.isArrowFunctionExpression(path.node.value) || t.isFunctionExpression(path.node.value))) {
          const name = path.node.key.name;
          const params = getParams(path.node.value.params);
          const parentClass = path.findParent((p) => p.isClassDeclaration());
          let isExported = false;

          if (parentClass && (t.isExportNamedDeclaration(parentClass.parent) || t.isExportDefaultDeclaration(parentClass.parent))) {
            isExported = true;
          }
          if (!resultArray.some((func) => func.name === name)) {
            resultArray.push({ name, isExported, arg: params, filePath, start: path.node.value.start, end: path.node.value.end });
          }
        }
      }
    });

    // specifierで指定されたエイリアス/エクスポート対象のフラグを更新
    resultArray.forEach((func) => {
      if (explicitlyExportedNames.has(func.name)) {
        func.isExported = true;
      }
    });

  } catch (error) {
    console.log(`getFunc Failed to process file: ${filePath}. Error: ${error}`);
  }

  if (mode === 0) {
    return resultArray.filter((func) => func.isExported);
  } else if (mode === 1) {
    return resultArray;
  } else {
    throw new Error('Invalid mode specified. Use 0 for exported functions only or 1 for all functions.');
  }
};

export const getBasicFunctionInfo = async (filePath: string, mode = 0): Promise<FunctionInfo_funcRange[]> => {
  const extendedData = await getFunction(filePath, mode);

  return extendedData.map((func) => ({
    funcname: func.name,
    arg: func.arg,
    filePath: func.filePath,
    start: func.start as number,
    end: func.end as number,
  }));
};

const isObfuscated = (fileContent: string): boolean => {
  if (!fileContent || fileContent.trim() === '') return false;

  const lines = fileContent.split('\n');
  if (lines.length === 0) return false;
  // 1行の平均文字数が100文字を超えているか
  const avgLineLength = fileContent.length / lines.length;
  if (avgLineLength > 100) {
    return true;
  }
  // コード100文字あたりに対して、1文字の変数が10個以上ある
  const singleCharVars = (fileContent.match(/\b[a-zA-Z]\b/g) || []).length;
  const ratio = singleCharVars / (fileContent.length / 100);
  if (ratio > 10) {
    return true;
  }

  return false;
};