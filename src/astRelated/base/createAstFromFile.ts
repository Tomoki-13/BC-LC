import * as parser from '@babel/parser';
import { File } from '@babel/types';

/**
 * ソース文字列を Babel AST にする（拡張子で TS/JSX プラグインを出し分け）入力: パス+内容 / 出力: File or 失敗時 null
 *   .ts/.mts/.cts/.tsx のみ typescript プラグインを付ける。
 *   プレーン JS(.js/.mjs/.cjs) に typescript を付けると `<` を TS ジェネリックと誤解釈して parse 失敗するため付けない。
 */
export const createAstFromFile = (filePath: string, fileContent: string): File | null => {
  try {
    const isTypeScript = /\.(ts|mts|cts|tsx)$/.test(filePath);
    const plugins: parser.ParserPlugin[] = ['decorators-legacy'];
    if (isTypeScript) plugins.push('typescript');

    // JSX: .tsx/.jsx は確定。JS は JSX 断片が見えるときのみ（.ts は generics と衝突するので付けない）
    const wantsJsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
      || (!isTypeScript && /<[A-Za-z]/.test(fileContent));
    if (wantsJsx) plugins.push('jsx');

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
    console.error('AST creation not possible:');
    console.error(error);
    return null;
  }
};
