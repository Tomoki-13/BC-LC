import { promises as fsPromises } from 'fs';
import traverse from "@babel/traverse";
import * as t from "@babel/types";

import { createAstFromFile } from '../base/createAstFromFile';
// パスと関数名から関数使用部分を抽出　
// メソッド単位までのパターン生成
export const analyzeMethod = async (filePath: string, funcName: string): Promise<string[]> => {
  let resultArray: string[] = [];
  try {
    let codes: string[] = [];
    //ファイルの内容を取得
    if (filePath.endsWith('.js') || filePath.endsWith('.ts')) {
      const fileContent: string = await fsPromises.readFile(filePath, 'utf8');
      const parsed = createAstFromFile(filePath, fileContent);
      if (parsed === null) {
        return [];
      }
      traverse(parsed, {
        VariableDeclarator(path: any) {
          const declarationNode = path.findParent((p: any) => t.isVariableDeclaration(p.node));
          if (t.isIdentifier(path.node.init?.callee) && path.node.init.callee.name === '_interopRequireDefault') {
            const init = path.node.init;
            if (init.arguments && init.arguments.some((arg: t.Expression | t.Identifier) => t.isIdentifier(arg) && new RegExp(`^${funcName}(?![a-zA-Z])`).test(arg.name))) {
              const code: string = fileContent.substring(declarationNode.node.start, declarationNode.node.end);
              codes.push(code);
            }
          } else if (t.isMemberExpression(path.node.init) && path.node.init.name === funcName && path.node.init.property.name === 'default') {
            //.default対応
            const code = fileContent.substring(declarationNode.node.start, declarationNode.node.end);
            codes.push(code);
          }
        },
        CallExpression(path: any) {
          //関数の呼び出しを見つける　(?![a-zA-Z])類似名した別名を除外
          if (t.isIdentifier(path.node.callee)) {
            if (new RegExp(`^${funcName}(?![a-zA-Z])`).test(path.node.callee.name)) {
              const code: string = fileContent.substring(path.node.start, path.node.end);
              codes.push(code);
            }
          } else if (t.isMemberExpression(path.node.callee)) {
            if (t.isIdentifier(path.node.callee.object) && new RegExp(`^${funcName}(?![a-zA-Z])`).test(path.node.callee.object.name)) {
              const code: string = fileContent.substring(path.node.start, path.node.end);
              //mockを行で削除
              // if(!code.includes('mockImplementation')){
              //     codes.push(code);
              // }
              codes.push(code);
            } else if (path.node.callee.object && t.isMemberExpression(path.node.callee.object)) {
              //~~.default.~~()の取得
              if (path.node.callee.object.object && t.isIdentifier(path.node.callee.object.object) && new RegExp(`^${funcName}(?![a-zA-Z])`).test(path.node.callee.object.object.name)) {
                const code: string = fileContent.substring(path.node.start, path.node.end);
                codes.push(code);
              }
            }
          }
        },
        NewExpression(path: any) {
          // NewExpression:returnにマッチ
          if (t.isIdentifier(path.node.callee)) {
            if (new RegExp(`^${funcName}(?![a-zA-Z])`).test(path.node.callee.name)) {
              const code: string = fileContent.substring(path.node.start, path.node.end);
              codes.push(code);
            }
          } else if (t.isMemberExpression(path.node.callee)) {
            if (t.isIdentifier(path.node.callee.object) && new RegExp(`^${funcName}(?![a-zA-Z])`).test(path.node.callee.object.name)) {
              const code: string = fileContent.substring(path.node.start, path.node.end);
              codes.push(code);
            } else if (path.node.callee.object && t.isMemberExpression(path.node.callee.object)) {
              //~~.default.~~の取得
              if (path.node.callee.object.object && t.isIdentifier(path.node.callee.object.object) &&
                new RegExp(`^${funcName}(?![a-zA-Z])`).test(path.node.callee.object.object.name)) {
                const code: string = fileContent.substring(path.node.start, path.node.end);
                codes.push(code);
              }
            }
          }
        },
      });
    }
    if (codes.length > 0) {
      resultArray = resultArray.concat(codes);
    }
  } catch (error) {
    //console.log(`analyzeMethod: Failed to create AST for file: ${filePath}`);
    //console.log(error);
  }
  return resultArray;
}
