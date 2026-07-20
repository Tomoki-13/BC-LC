import ApiScope from '../libDiff/apiScope';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

// ドキュメント照合（トークン分割 → export 名と照合）の挙動を検証する
const DOCS_DIR = './src/__tests__/inputFiles/docs';

// 検証用の surface（export 関数群）名前だけ重要なので他フィールドは最小
const sym = (name: string, exportStyle: ApiSymbol['exportStyle'] = 'esm-named'): ApiSymbol =>
  ({ name, kind: 'function', exportStyle, params: [], returnExprs: [], isAsync: false, optionKeys: [], filePath: 'index.js' });
const surface: ApiSurface = {
  version: '2.0.0', tag: 'v2.0.0', scope: 'export',
  symbols: [sym('parse'), sym('stringify'), sym('internalHelper'), sym('legacyOption'), sym('default', 'cjs-module-default')],
};
const keptNames = (s: ApiSurface) => s.symbols.map(x => x.name).sort();

describe('ドキュメント照合（collectDocTokens + filterSurface）', () => {
  test('README のトークンに export 名が含まれる（散文＋コード例の両方から拾う）', () => {
    const usage = ApiScope.collectDocTokens(DOCS_DIR, /*onlyReadme*/ true);
    // 散文の `parse`/`stringify`、コード例の require/demo などが入る
    expect(usage.named.has('parse')).toBe(true);
    expect(usage.named.has('stringify')).toBe(true);
    expect(usage.named.has('legacyOption')).toBe(false); // README には無い（CHANGELOG のみ）
  });

  test('mode2(README) は README で言及された export だけ残す', () => {
    const usage = ApiScope.collectDocTokens(DOCS_DIR, true);
    const filtered = ApiScope.filterSurface(surface, 2, usage);
    // parse/stringify は残り、内部ヘルパー・legacyOption は落ちる
    expect(keptNames(filtered)).toEqual(['parse', 'stringify']);
  });

  test('mode3(全md) は CHANGELOG=版までのリリースノートも見て legacyOption を追加で残す', () => {
    const usage = ApiScope.collectDocTokens(DOCS_DIR, /*onlyReadme*/ false);
    const filtered = ApiScope.filterSurface(surface, 3, usage);
    // README(parse,stringify) + CHANGELOG(legacyOption,parse) の言及分
    expect(keptNames(filtered)).toEqual(['legacyOption', 'parse', 'stringify']);
  });

  test('既知の限界: 無名 default export はドキュメントの語と名前一致せず落ちる', () => {
    const usage = ApiScope.collectDocTokens(DOCS_DIR, false);
    const filtered = ApiScope.filterSurface(surface, 3, usage);
    expect(filtered.symbols.some(x => x.name === 'default')).toBe(false);
  });

  test('extraTexts で repo 外のドキュメント（例: GitHub Releases 本文）も足せる', () => {
    const usage = ApiScope.collectDocTokens(DOCS_DIR, true, ['Added new `flush` method.']);
    expect(usage.named.has('flush')).toBe(true);
  });

  test('mode0 は絞り込みなし（全 export をそのまま返す）', () => {
    const filtered = ApiScope.filterSurface(surface, 0, ApiScope.collectDocTokens(DOCS_DIR, true));
    expect(keptNames(filtered)).toEqual(['default', 'internalHelper', 'legacyOption', 'parse', 'stringify']);
  });
});
