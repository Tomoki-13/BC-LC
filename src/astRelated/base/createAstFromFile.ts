import * as parser from '@babel/parser';
import { File } from '@babel/types';

/** ソース文字列を Babel AST にする（拡張子/内容から JSX を自動判定）。入力: パス+内容 / 出力: File or 失敗時 null */
export const createAstFromFile = (filePath: string, fileContent: string): File | null => {
  try {
    const plugins: parser.ParserPlugin[] = [
      'typescript',                // TypeScript構文
      'decorators-legacy',         // デコレーター
    ];

    // JSX対応（TSXやJSXが含まれる場合）
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || /<[A-Za-z]/.test(fileContent)) {
      plugins.push('jsx');
    }

    const ast = parser.parse(fileContent, {
      sourceType: 'unambiguous',
      plugins,
      errorRecovery: true,
    });

    return ast;
  } catch (error) {
    // console.error(`AST creation not possible: ${filePath}`);
    // console.error(error);
    return null;
  }
};

/** パス無しでソース文字列を Babel AST にする（markdown コードフェンス等の断片用）。失敗時 null */
export const createAstFromContent = (fileContent: string): File | null => {
  try {
    const plugins: parser.ParserPlugin[] = [
      'typescript',                // TypeScript構文
      'decorators-legacy',         // デコレーター
    ];

    const ast = parser.parse(fileContent, {
      sourceType: 'unambiguous',
      plugins,
      errorRecovery: true,
    });

    return ast;
  } catch (error) {
    console.error(`AST creation not possible:`);
    console.error(error);
    return null;
  }
};
