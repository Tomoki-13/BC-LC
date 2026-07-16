import { promises as fs } from 'fs';
import * as path from 'path';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { createAstFromFile } from './base/createAstFromFile';

export interface TestTargetFunction {
  funcName: string;
  sourcePath: string; // インポート元の解決済み絶対パス（拡張子なしの可能性あり）
}

export interface TestTargetResult {
  testFilePath: string;
  importedFunctions: TestTargetFunction[];
}

/**
 * テストファイルを解析し、リポジトリ内からインポートされている関数を抽出する
 * @param testFilePath テストファイルの絶対パス
 */
export const extractTargetFunctionsInTest = async (testFilePath: string): Promise<TestTargetResult | null> => {
  try {
    const fileContent: string = await fs.readFile(testFilePath, 'utf8');
    const parsed = createAstFromFile(testFilePath, fileContent);

    if (!parsed) {
      console.log(`Failed to create AST for test file: ${testFilePath}`);
      return null;
    }

    const importedFunctions: TestTargetFunction[] = [];

    traverse(parsed, {
      ImportDeclaration(pathNode) {
        const sourceValue = pathNode.node.source.value;

        // リポジトリ内のファイル（相対パス）のみを対象とする
        // 'react' や 'lodash' などの外部ライブラリは弾く
        if (sourceValue.startsWith('.')) {
          // テストファイルからの相対パスを絶対パスに解決
          const resolvedPath = path.resolve(path.dirname(testFilePath), sourceValue);

          pathNode.node.specifiers.forEach((spec) => {
            if (t.isImportSpecifier(spec)) {
              // 名前付きインポート (例: import { myFunc } from './myFile')
              const importedName = t.isIdentifier(spec.imported) 
                ? spec.imported.name 
                : spec.imported.value;
              
              importedFunctions.push({ 
                funcName: importedName, 
                sourcePath: resolvedPath 
              });
            } else if (t.isImportDefaultSpecifier(spec)) {
              // デフォルトインポート (例: import myFunc from './myFile')
              // ※デフォルトインポートの場合、テストファイル側で任意の名前を付けられるためローカル名を取得します
              importedFunctions.push({ 
                funcName: spec.local.name, 
                sourcePath: resolvedPath 
              });
            }
          });
        }
      }
    });

    return {
      testFilePath,
      importedFunctions,
    };
  } catch (error) {
    console.error(`Error processing test file ${testFilePath}:`, error);
    return null;
  }
};