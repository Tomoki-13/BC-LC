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

/**
 * 詳細なメタデータを含む関数情報を抽出するメインロジック
 */
export const getFunction = async (filePath: string, mode = 0): Promise<ExtendedFunctionMetaInfo[]> => {
  const resultArray: ExtendedFunctionMetaInfo[] = [];
  const explicitlyExportedNames = new Set<string>();
  const exportedFunctions = new Set<string>();

  try {
    if (!filePath.match(/\.(js|ts|jsx|tsx)$/)) return [];

    const fileContent: string = await fs.readFile(filePath, 'utf8');
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
        if (path.node.specifiers) {
          path.node.specifiers.forEach((spec) => {
            if (t.isExportSpecifier(spec) && t.isIdentifier(spec.local)) {
              explicitlyExportedNames.add(spec.local.name);
            }
          });
        }
      },
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
      AssignmentExpression(path) {
        const left = path.node.left;
        const right = path.node.right;

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
            resultArray.push({ name, isExported: true, arg: params, filePath, start: right.start, end: right.end });
          }
        }
      },
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

    resultArray.forEach((func) => {
      if (explicitlyExportedNames.has(func.name)) {
        func.isExported = true;
      }
    });

  } catch (error) {
    console.log(`getFunc Failed to process file: ${filePath}. Error: ${error}`);
  }

  // getFunction自体もmodeに応じた絞り込みを行う
  if (mode === 0) {
    return resultArray.filter((func) => func.isExported);
  } else if (mode === 1) {
    return resultArray;
  } else {
    throw new Error('Invalid mode specified.');
  }
};

/**
 * 既存処理用: getFunctionで取得したデータをFunctionInfo_funcRange型に変換して出力する
 */
export const toExportedFunctionInfo = async (filePath: string, mode = 0): Promise<FunctionInfo_funcRange[]> => {
  // getFunction を実行して Extended データを受け取る
  const data = await getFunction(filePath, mode);

  // 指定された型 (FunctionInfo_funcRange) にマッピングして返す
  return data.map((func) => ({
    funcname: func.name,
    arg: func.arg,
    filePath: func.filePath,
    start: func.start as number,
    end: func.end as number,
  }));
};