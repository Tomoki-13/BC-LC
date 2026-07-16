import { promises as fs } from 'fs';
import traverseImport from '@babel/traverse';
import * as t from '@babel/types';

// ESM 経由だと default が { default: fn } になりうるため callable を取り出す
const traverse = ((traverseImport as any).default ?? traverseImport) as typeof traverseImport;

import { createAstFromFile } from '../base/createAstFromFile';
import { ExtendedFunctionMetaInfo, FunctionInfo_funcRange, ExportStyleTag, SymbolKindTag } from '../../types/FunctionInfo';

// options 引数とみなす識別子名（body 内の opts.key 読み取りを拾う対象）
const OPTION_PARAM_RE = /^(opts?|options?|config|conf|settings?|params?|args)$/i;

// ObjectPattern の宣言キーを集める（{a, b = 1, c: renamed, ...rest} → a,b,c）
const collectPatternKeys = (pattern: any, keys: Set<string>): void => {
  for (const p of pattern.properties) {
    if (t.isObjectProperty(p) && !p.computed) {
      if (t.isIdentifier(p.key)) keys.add(p.key.name);
      else if (t.isStringLiteral(p.key)) keys.add(p.key.value);
    }
  }
};

// 関数ノードが消費する options キー（(A)分割代入 object 引数 / (B)opts 風引数への body 読み取り）
const functionOptionKeys = (node: any, nodePath: any): string[] => {
  const keys = new Set<string>();
  const optionParamNames: string[] = [];
  for (const param of node.params as any[]) {
    const target = t.isAssignmentPattern(param) ? param.left : param; // 既定値付き引数を剥がす
    if (t.isObjectPattern(target)) collectPatternKeys(target, keys);
    else if (t.isIdentifier(target) && OPTION_PARAM_RE.test(target.name)) optionParamNames.push(target.name);
  }
  if (optionParamNames.length > 0) {
    nodePath.traverse({
      MemberExpression(mp: any) {
        const mn = mp.node;
        if (!mn.computed && t.isIdentifier(mn.object) && optionParamNames.includes(mn.object.name)
          && t.isIdentifier(mn.property)) keys.add(mn.property.name);
      },
      VariableDeclarator(vp: any) {
        const vn = vp.node;
        if (t.isObjectPattern(vn.id) && t.isIdentifier(vn.init) && optionParamNames.includes(vn.init.name))
          collectPatternKeys(vn.id, keys);
      },
    });
  }
  return [...keys].sort();
};

// 拡張メタデータ用ヘルパー: return文の式をソース文字列として抽出
const getReturnExpressionsFromFunctionNode = (funcNode: any, fileContent: string): string[] => {
  const exprs: string[] = [];
  if (!funcNode || !fileContent) return exprs;

  const walk = (node: any, depth = 0) => {
    if (!node || typeof node !== 'object') return;
    if (depth > 0 && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) {
      return;
    }
    if (node.type === 'ReturnStatement') {
      if (node.argument && typeof node.argument.start === 'number' && typeof node.argument.end === 'number') {
        exprs.push(fileContent.slice(node.argument.start, node.argument.end));
      }
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach((n: any) => walk(n, depth + 1));
      else if (v && typeof v === 'object' && v.type) walk(v, depth + 1);
    }
  };

  if (funcNode.body && funcNode.body.type && funcNode.body.type !== 'BlockStatement') {
    if (typeof funcNode.body.start === 'number' && typeof funcNode.body.end === 'number') {
      exprs.push(fileContent.slice(funcNode.body.start, funcNode.body.end));
    }
  } else if (funcNode.body) {
    walk(funcNode.body, 0);
  }

  return exprs;
};

// mode = 0: exportされている関数のみを抽出, mode = 1: 全ての関数を抽出
export const getFunction = async (filePath: string, mode = 0): Promise<ExtendedFunctionMetaInfo[]> => {
  const resultArray: ExtendedFunctionMetaInfo[] = [];
  const explicitlyExportedNames = new Set<string>();
  const exportedFunctions = new Set<string>();
  const prototypeAliases = new Map<string, string>(); // P.method のようなプロトタイプエイリアスを追跡
  // module.exports = <識別子> で公開される「デフォルトエクスポートの実体」識別子
  const exportRootIds = new Set<string>();
  // <exportRoot>.prop = 関数/識別子 （uuid.v4 = v4 のようなプロパティ公開）を後段で解決するため収集
  const propAssignments: { objName: string; prop: string; funcNode: any | null; valueName: string | null }[] = [];

  try {
    if (!filePath.match(/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/)) return [];

    const fileContent: string = await fs.readFile(filePath, 'utf8');
    // 異常な圧縮コードを除外（例: 1行が非常に長い場合）
    if (isObfuscated(fileContent)) {
      //console.log(`File ${filePath} is detected as obfuscated. Skipping function extraction.`);
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

    // 拡張メタデータ用ヘルパー: ネストされたオブジェクト内の関数を再帰的に抽出
    const extractFunctionReferences = (objNode: any, pathPrefix = '', isExported = false) => {
      if (!t.isObjectExpression(objNode)) return;

      objNode.properties.forEach((prop: any) => {
        if (t.isObjectProperty(prop) || t.isObjectMethod(prop)) {
          let key;
          if (t.isIdentifier(prop.key)) key = prop.key.name;
          else if (t.isStringLiteral(prop.key)) key = prop.key.value;
          else return;

          const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;

          if (t.isObjectProperty(prop)) {
            if (t.isIdentifier(prop.value)) { 
              explicitlyExportedNames.add(prop.value.name); 
            } else if (t.isObjectExpression(prop.value)) { 
              extractFunctionReferences(prop.value, fullPath, isExported); 
            } else if (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value)) {
              const funcNode = prop.value;
              const internalName = (funcNode as any).id?.name;
              resultArray.push({
                name: internalName || fullPath,
                isExported,
                isPropertyFunction: true,
                propertyPath: fullPath,
                arg: getParams(funcNode.params),
                returnExprs: getReturnExpressionsFromFunctionNode(funcNode, fileContent),
                filePath,
                start: funcNode.start,
                end: funcNode.end,
              });
            }
          } else if (t.isObjectMethod(prop)) {
            resultArray.push({
              name: fullPath,
              isExported,
              isPropertyFunction: true,
              propertyPath: fullPath,
              arg: getParams(prop.params),
              returnExprs: getReturnExpressionsFromFunctionNode(prop, fileContent),
              filePath,
              start: prop.start,
              end: prop.end,
            });
          }
        }
      });
    };

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
              returnExprs: getReturnExpressionsFromFunctionNode(path.node, fileContent),
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
              resultArray.push({ name, isExported: true, arg: params, returnExprs: getReturnExpressionsFromFunctionNode(path.node.declaration, fileContent), filePath, start: path.node.declaration.start, end: path.node.declaration.end });
            }
          } else if (t.isVariableDeclaration(path.node.declaration)) {
            for (const declarator of path.node.declaration.declarations) {
              if (t.isVariableDeclarator(declarator) && t.isIdentifier(declarator.id) && declarator.init &&
                  (t.isFunctionExpression(declarator.init) || t.isArrowFunctionExpression(declarator.init))) {
                const name = declarator.id.name;
                const params = getParams(declarator.init.params);
                exportedFunctions.add(serializeFunction(name, params));
                if (!resultArray.some((func) => func.name === name)) {
                  resultArray.push({ name, isExported: true, arg: params, returnExprs: getReturnExpressionsFromFunctionNode(declarator.init, fileContent), filePath, start: declarator.init.start, end: declarator.init.end });
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
            resultArray.push({ name, isExported: true, arg: params, returnExprs: getReturnExpressionsFromFunctionNode(path.node.declaration, fileContent), filePath, start: path.node.declaration.start, end: path.node.declaration.end });
          }
        } else if (t.isIdentifier(path.node.declaration)) {
          explicitlyExportedNames.add(path.node.declaration.name);
        } else if (t.isObjectExpression(path.node.declaration)) {
          extractFunctionReferences(path.node.declaration, '', true);
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
              returnExprs: getReturnExpressionsFromFunctionNode(path.node.init, fileContent),
              filePath,
              start: path.node.init.start,
              end: path.node.init.end,
            });
          }
        }
        // P = {} のような代入をプロトタイプエイリアスの候補として追跡
        if (t.isIdentifier(path.node.id) && t.isObjectExpression(path.node.init)) {
          prototypeAliases.set(path.node.id.name, path.node.id.name);
        }
      },

      AssignmentExpression(path) {
        const left = path.node.left;
        const right = path.node.right;

        // module.exports = { a: funcA, b: { c: funcC } } のネスト解析
        if (t.isObjectExpression(right)) {
          const isModuleExports = 
            (t.isIdentifier(left) && left.name === 'exports') ||
            (t.isMemberExpression(left) && t.isIdentifier(left.object, { name: 'module' }) && t.isIdentifier(left.property, { name: 'exports' }));

          if (isModuleExports) {
            extractFunctionReferences(right, '', true);
          }
        }

        // module.exports = function(){...} / = (...) => {...}（無名の直接デフォルト export）
        //   単一関数モジュールの最頻出形。名前が無いので関数式の id か 'default' を採用
        if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
          const isModuleExportsDefault =
            (t.isIdentifier(left) && left.name === 'exports') ||
            (t.isMemberExpression(left) && !left.computed
              && t.isIdentifier(left.object, { name: 'module' }) && t.isIdentifier(left.property, { name: 'exports' }));
          if (isModuleExportsDefault) {
            const fnName = (t.isFunctionExpression(right) && right.id?.name) ? right.id.name : 'default';
            if (!resultArray.some(f => f.name === fnName && f.start === right.start)) {
              resultArray.push({
                name: fnName,
                isExported: true,
                arg: getParams(right.params),
                returnExprs: getReturnExpressionsFromFunctionNode(right, fileContent),
                filePath,
                start: right.start,
                end: right.end,
              });
            }
          }
        }

        // プロトタイプやインスタンスへの関数代入 (P.multiply = ..., Calculator.prototype.add = ...)
        if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.property)) {
          const object = left.object;
          const methodName = left.property.name;

          if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
            let isInstance = false;
            let protoObj = null;
            let funcName = null;

            if (t.isIdentifier(object) && prototypeAliases.has(object.name)) {
              isInstance = true;
              protoObj = object.name;
              funcName = `${object.name}.${methodName}`;
            } else if (t.isMemberExpression(object) && t.isIdentifier(object.object) && t.isIdentifier(object.property, { name: 'prototype' })) {
              isInstance = true;
              protoObj = `${object.object.name}.prototype`;
              funcName = `${protoObj}.${methodName}`;
            }

            if (isInstance && funcName) {
              if (!resultArray.some(f => f.name === funcName)) {
                resultArray.push({
                  name: funcName,
                  isExported: false,
                  arg: getParams(right.params),
                  returnExprs: getReturnExpressionsFromFunctionNode(right, fileContent),
                  filePath,
                  start: right.start,
                  end: right.end,
                  isInstanceMethod: true,
                  prototypeObj: protoObj as string,
                  isPotentialPrototype: prototypeAliases.has(object.type === 'Identifier' ? object.name : ''),
                });
              }
            }
          }
        }

        // module.exports = <識別子> / exports.x = <識別子>（参照によるエクスポート）を捕捉
        //   例: function v4(){}; module.exports = v4;  /  exports.foo = foo;
        if (t.isIdentifier(right)) {
          const isModuleExportsDefault =
            t.isIdentifier(left, { name: 'exports' }) ||
            (t.isMemberExpression(left) && t.isIdentifier(left.object, { name: 'module' }) && t.isIdentifier(left.property, { name: 'exports' }));
          const isExportsProperty =
            t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.property) &&
            (t.isIdentifier(left.object, { name: 'exports' }) ||
              (t.isMemberExpression(left.object) && t.isIdentifier(left.object.object, { name: 'module' }) && t.isIdentifier(left.object.property, { name: 'exports' })));
          if (isModuleExportsDefault || isExportsProperty) {
            explicitlyExportedNames.add(right.name);
          }
          if (isModuleExportsDefault) {
            exportRootIds.add(right.name); // module.exports = uuid → uuid が公開の実体
          }
        }

        // <識別子>.prop = 関数/識別子（uuid.v4 = v4 のようなプロパティ公開）を収集（後段で解決）
        //   ※ exports / module.exports 系は既存処理が拾うので除外
        if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.object)
            && left.object.name !== 'exports' && left.object.name !== 'module'
            && t.isIdentifier(left.property)) {
          const objName = left.object.name;
          const prop = left.property.name;
          if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) {
            propAssignments.push({ objName, prop, funcNode: right, valueName: null });
          } else if (t.isIdentifier(right)) {
            propAssignments.push({ objName, prop, funcNode: null, valueName: right.name });
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
              returnExprs: getReturnExpressionsFromFunctionNode(right, fileContent),
              filePath,
              start: right.start,
              end: right.end,
            });
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
            resultArray.push({ name, isExported, arg: params, returnExprs: getReturnExpressionsFromFunctionNode(path.node, fileContent), filePath, start: path.node.start, end: path.node.end });
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
            resultArray.push({ name, isExported, arg: params, returnExprs: getReturnExpressionsFromFunctionNode(path.node.value, fileContent), filePath, start: path.node.value.start, end: path.node.value.end });
          }
        }
      }
    });

    // プロパティ公開の解決: <exportRoot>.prop = 関数/識別子（例 uuid.v4 = v4）
    for (const pa of propAssignments) {
      if (!exportRootIds.has(pa.objName)) continue; // 公開の実体(module.exports=X の X)への代入のみ
      const accessPath = `${pa.objName}.${pa.prop}`;
      if (pa.funcNode) {
        // インライン関数を公開: 新規 export シンボルとして追加
        if (!resultArray.some(f => f.propertyPath === accessPath || (f.name === pa.prop && !f.isPropertyFunction))) {
          resultArray.push({
            name: pa.prop,
            isExported: true,
            isPropertyFunction: true,
            propertyPath: accessPath,
            arg: getParams(pa.funcNode.params),
            returnExprs: getReturnExpressionsFromFunctionNode(pa.funcNode, fileContent),
            filePath,
            start: pa.funcNode.start,
            end: pa.funcNode.end,
          });
        }
      } else if (pa.valueName) {
        // 参照公開(uuid.v4 = v4): 実体は多くが別ファイル。export とみなし、同ファイルに実体があれば accessPath 付与
        explicitlyExportedNames.add(pa.valueName);
        const sym = resultArray.find(f => f.name === pa.valueName);
        if (sym) { sym.isExported = true; sym.isPropertyFunction = true; sym.propertyPath = accessPath; }
      }
    }

    resultArray.forEach((func) => {
      if (explicitlyExportedNames.has(func.name)) {
        func.isExported = true;
      }
    });

    // メタ情報（async / optionKeys / exportStyle / kind）を同じ AST の2巡目で収集し付与
    //   関数系メタは start（ノード位置）で、exportStyle/kind は name で resultArray に対応づける
    const asyncOptByStart = new Map<number, { isAsync: boolean; optionKeys: string[] }>();
    const styleByName = new Map<string, ExportStyleTag>();
    const kindByName = new Map<string, SymbolKindTag>();
    traverse(parsed, {
      enter(p) {
        const n: any = p.node;
        if ((t.isFunctionDeclaration(n) || t.isFunctionExpression(n) || t.isArrowFunctionExpression(n) || t.isObjectMethod(n)) && n.start != null) {
          asyncOptByStart.set(n.start, { isAsync: !!n.async, optionKeys: functionOptionKeys(n, p) });
        }
      },
      ExportNamedDeclaration(p) {
        const n = p.node;
        const style: ExportStyleTag = n.source ? 'esm-reexport' : 'esm-named';
        if (n.declaration) {
          if (t.isFunctionDeclaration(n.declaration) && n.declaration.id) styleByName.set(n.declaration.id.name, 'esm-named');
          else if (t.isClassDeclaration(n.declaration) && n.declaration.id) { styleByName.set(n.declaration.id.name, 'esm-named'); kindByName.set(n.declaration.id.name, 'class'); }
          else if (t.isVariableDeclaration(n.declaration)) {
            for (const d of n.declaration.declarations) if (t.isIdentifier(d.id)) styleByName.set(d.id.name, 'esm-named');
          }
        }
        for (const s of n.specifiers) if (t.isExportSpecifier(s) && t.isIdentifier(s.exported)) styleByName.set(s.exported.name, style);
      },
      ExportDefaultDeclaration(p) {
        const d: any = p.node.declaration;
        const name = (t.isFunctionDeclaration(d) || t.isClassDeclaration(d)) && d.id ? d.id.name : 'default';
        styleByName.set(name, 'esm-default');
        if (t.isClassDeclaration(d)) kindByName.set(name, 'class');
      },
      AssignmentExpression(p) {
        const { left, right } = p.node as any;
        if (!t.isMemberExpression(left) || left.computed) return;
        const isModuleExports = t.isIdentifier(left.object, { name: 'module' }) && t.isIdentifier(left.property, { name: 'exports' });
        const isExportsProp = t.isIdentifier(left.object, { name: 'exports' }) && t.isIdentifier(left.property);
        const isModuleExportsProp = t.isMemberExpression(left.object) && !left.object.computed
          && t.isIdentifier(left.object.object, { name: 'module' }) && t.isIdentifier(left.object.property, { name: 'exports' }) && t.isIdentifier(left.property);
        if (isModuleExports) {
          if (t.isObjectExpression(right)) {
            for (const pr of right.properties) if (t.isObjectProperty(pr) && !pr.computed && t.isIdentifier(pr.key)) styleByName.set(pr.key.name, 'cjs-property');
          } else {
            const name = t.isIdentifier(right) ? right.name : 'default';
            styleByName.set(name, 'cjs-module-default');
            if (t.isClassExpression(right)) kindByName.set(name, 'class');
          }
        } else if ((isExportsProp || isModuleExportsProp) && t.isIdentifier(left.property)) {
          styleByName.set(left.property.name, 'cjs-property');
        }
      },
    });
    resultArray.forEach((func) => {
      const ao = func.start != null ? asyncOptByStart.get(func.start) : undefined;
      func.isAsync = ao?.isAsync ?? false;
      func.optionKeys = ao?.optionKeys ?? [];
      func.exportStyle = styleByName.get(func.name) ?? 'unknown';
      func.kind = kindByName.get(func.name) ?? 'function';
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

/* mode = 0: exportされている関数のみを抽出, mode = 1: 全ての関数を抽出 
  既存のFunctionInfo_funcRange形式で返すためのラッパー関数
*/
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