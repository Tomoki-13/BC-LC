import { typeAwarePatternMatch } from '../clientDetect/match/typeAwarePatternMatch';
import { normalizeImportSpacing } from '../clientDetect/extract/useAst';
import { createAstFromFile } from '../astRelated/base/createAstFromFile';
import { generatePatterns } from '../patternGen/generatePatterns';
import type { LossCandidate } from '../types/LibDiff';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

const block = (code: string, args = 2): ExtractFunctionCallsResult =>
  ({ FunctionCallCode: code, filePath: 'a.js', line: 1, argTypes: Array.from({ length: args }, () => ['unknown']), argContexts: [] });
const candidate = (lib: string, tag: LossCandidate['tag'] = 'return-changed', symbol = 'default'): LossCandidate =>
  ({ libName: lib, preVersion: '1.0.0', postVersion: '2.0.0', symbol, filePath: 'index.js', tag, label: '', confidence: 'semantic' });
const patternsOf = (c: LossCandidate) => generatePatterns([c], undefined, undefined).patterns;
const matched = (c: LossCandidate, lines: string[]) =>
  typeAwarePatternMatch(patternsOf(c), [lines.map(l => block(l))]).matched;

describe('照合: 引数に括弧のある呼び出し', () => {
  test('pump(logentriesRawStream(pathname, query), JSONStream.parse(\'*\'))', () => {
    expect(matched(candidate('pump'), ["const pump = require('pump')", "pump(logentriesRawStream(pathname, query), JSONStream.parse('*'))"])).toBe(true);
  });
  test('leven(str.toLowerCase(), name.toLowerCase())', () => {
    expect(matched(candidate('leven'), ["const leven = require('leven')", 'leven(str.toLowerCase(), name.toLowerCase())'])).toBe(true);
  });
  test('コールバックの中にメソッド呼び出しがある pkg(repo, \'latest\', function (err, json) { … })', () => {
    expect(matched(candidate('package-json'), ["var pkg = require('package-json')",
      "pkg(repo, 'latest', function (err, json) { if (err) { return next(err); } next(null, acc.concat(filter(json, pattern))); })"])).toBe(true);
  });
  test('呼び出しの後ろのメソッドチェーン pump(a, b).on(\'error\', cb) は今までどおり当てない', () => {
    expect(matched(candidate('pump'), ["const pump = require('pump')", "pump(a(b), c).on('error', cb)"])).toBe(false);
  });
});

describe('照合: import * as x で読んで x() と呼ぶ形', () => {
  test('default の呼び出し（return-changed）', () => {
    expect(matched(candidate('helmet'), ["import * as helmet from 'helmet'", 'helmet()'])).toBe(true);
  });
  test('入口の default の削除', () => {
    const c = { ...candidate('uuid', 'entry-default-removed'), entryEsm: true };
    const pre = { version: '1', tag: 'v1', scope: 'export' as const, symbols: [{ name: 'default', kind: 'function' as const, exportStyle: 'cjs-module-default' as const, filePath: 'index.js' }] };
    const pats = generatePatterns([c], pre, undefined).patterns;
    expect(typeAwarePatternMatch(pats, [[block('import * as createUuid from "uuid"'), block('createUuid()', 0)]]).matched).toBe(true);
  });
  test('入口の default が値と読まれても呼ぶ形を作る（es6-promisify 5.0.0 の module.exports = (function () { … }())）', () => {
    const c = { ...candidate('es6-promisify', 'entry-default-removed'), entryEsm: true };
    const pre = { version: '1', tag: 'v1', scope: 'export' as const, symbols: [{ name: 'default', kind: 'value' as const, exportStyle: 'cjs-module-default' as const, filePath: 'lib/promisify.js' }] };
    const pats = generatePatterns([c], pre, undefined).patterns;
    expect(typeAwarePatternMatch(pats, [[block("const promisify = require('es6-promisify')"), block('promisify(fs.open)', 1)]]).matched).toBe(true);
    expect(typeAwarePatternMatch(pats, [[block("const promisify = require('es6-promisify')"), block('promisify.Promise', 0)]]).matched).toBe(false);
  });
  test('名前空間をメンバーとして使うだけなら default のパターンには当たらない', () => {
    expect(matched(candidate('helmet'), ["import * as helmet from 'helmet'", 'helmet.frameguard()'])).toBe(false);
  });
});

describe('抽出: 読み込みの空白をそろえる処理', () => {
  test('パッケージ名の中の from は変えない', () => {
    expect(normalizeImportSpacing("var resolveFrom = require('resolve-from')")).toBe("var resolveFrom = require('resolve-from')");
    expect(normalizeImportSpacing("import resolveFrom from 'resolve-from'")).toBe("import resolveFrom from 'resolve-from'");
  });
  test('from と引用符の間の空白は今までどおりそろえる', () => {
    expect(normalizeImportSpacing("import x from'lib'")).toBe("import x from 'lib'");
    expect(normalizeImportSpacing("import {a}from'lib'")).toBe("import {a}from 'lib'");
  });
});

describe('parse: 失敗したときだけ flow・functionBind を足して読み直す', () => {
  test('Flow の型注釈（wix/react-native-notifications の index.ios.js の形）', () => {
    const code = "/* @flow */\nimport uuid from 'uuid';\nclass A {\n  options: Object;\n  constructor(options: Object, handler: Function) {}\n}\nexport default A;";
    expect(createAstFromFile('index.ios.js', code)).not.toBeNull();
  });
  test('関数バインド構文（::this.f）', () => {
    expect(createAstFromFile('index.js', "compiler.plugin('compilation', ::this.toInjectDllModule);")).not.toBeNull();
  });
  test('TypeScript のファイルには足さない（読めなければ null のまま）', () => {
    expect(createAstFromFile('a.ts', 'compiler.plugin(::this.f);')).toBeNull();
  });
});
