// ESLint v9+ flat config（R-BC の構成を踏襲。静的にコード書式を整える）
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  // 解析対象外（出力・依存・成果物・テスト用フィクスチャ＝意図的な多様構文なので整形しない）
  { ignores: ['node_modules/', 'dist/', 'build/', 'coverage/', 'eslint.config.mjs', 'src/__tests__/inputFiles/'] },

  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      // require/module（CJS）と test/describe/expect（jest）を未定義扱いにしない
      globals: { ...globals.node, ...globals.jest },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // 未定義名は TypeScript が検査するため off（BufferEncoding 等の TS 型の誤検知を防ぐ）
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // 全角空白は日本語コメント/文字列/正規表現では許容
      'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true, skipTemplates: true, skipRegExps: true }],
      'no-useless-escape': 'warn',
      'no-console': 'off',
      'no-debugger': 'warn',
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'comma-dangle': ['error', 'always-multiline'],
      'indent': ['error', 2, { SwitchCase: 1 }],
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],
      'space-before-blocks': ['error', 'always'],
      'keyword-spacing': ['error', { before: true, after: true }],
      'arrow-spacing': ['error', { before: true, after: true }],
      'max-len': ['warn', { code: 200, ignoreStrings: true, ignoreTemplateLiterals: true }],
    },
  },
];
