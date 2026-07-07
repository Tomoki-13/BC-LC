import { getFunction } from '../analyzer/astRelated/trace/getFunction';
import type { ExtendedFunctionMetaInfo } from '../types/FunctionInfo';

// 各 export/関数形を1ファイルずつ用意し、getFunction が取りこぼさず抽出できるか検証する
const FORMS = './src/__tests__/inputFiles/forms';
const load = (file: string) => getFunction(`${FORMS}/${file}`, 0);
const names = (r: ExtendedFunctionMetaInfo[]) => r.map(f => f.name).sort();
const by = (r: ExtendedFunctionMetaInfo[]) => Object.fromEntries(r.map(f => [f.name, f]));

describe('getFunction: export 形態の網羅', () => {
  test('CJS: module.exports = { a, b }（オブジェクト export）', async () => {
    const r = await load('cjs_object.js');
    expect(names(r)).toEqual(['alpha', 'beta']);
    expect(by(r).alpha).toMatchObject({ isExported: true, arg: ['a'], exportStyle: 'cjs-property' });
  });

  test('CJS: exports.x / module.exports.x = function（プロパティ代入）', async () => {
    const r = await load('cjs_props.js');
    expect(names(r)).toEqual(['delta', 'gamma']);
    expect(by(r).gamma).toMatchObject({ isExported: true, arg: ['c'], exportStyle: 'cjs-property' });
  });

  test('CJS: module.exports = 識別子（named 実体の default 公開）', async () => {
    const r = await load('cjs_default.js');
    expect(names(r)).toEqual(['impl']);
    expect(by(r).impl).toMatchObject({ isExported: true, arg: ['x'], exportStyle: 'cjs-module-default' });
  });

  test('CJS: module.exports = function(){}（無名 default・単一関数モジュール）', async () => {
    const r = await load('cjs_anon_fn.js');
    expect(names(r)).toEqual(['default']);
    expect(by(r).default).toMatchObject({ isExported: true, arg: ['name'], exportStyle: 'cjs-module-default' });
  });

  test('CJS: module.exports = (a, b) => ...（無名アロー default）', async () => {
    const r = await load('cjs_anon_arrow.js');
    expect(names(r)).toEqual(['default']);
    expect(by(r).default).toMatchObject({ arg: ['str', 'count'], exportStyle: 'cjs-module-default' });
  });

  test('CJS: プロパティ公開（uuid.v4 = v4 型）', async () => {
    const r = await load('cjs_expose.js');
    expect(names(r).sort()).toEqual(['helper', 'main', 'v4impl']);
    // main.v4 = v4impl（識別子公開）→ 実体 v4impl に accessPath 付与
    expect(by(r).v4impl).toMatchObject({ isExported: true, propertyPath: 'main.v4' });
    // main.helper = function（インライン公開）→ 新規シンボル helper
    expect(by(r).helper).toMatchObject({ isExported: true, arg: ['h'], propertyPath: 'main.helper' });
    expect(by(r).main).toMatchObject({ exportStyle: 'cjs-module-default' });
  });

  test('ESM(.js): export function / const arrow / default / export {x}', async () => {
    const r = await load('esm.js');
    expect(names(r)).toEqual(['ea', 'eb', 'ec', 'ed']);
    expect(by(r).ea).toMatchObject({ isExported: true, exportStyle: 'esm-named' });
    expect(by(r).ec).toMatchObject({ isExported: true, exportStyle: 'esm-default' });
    expect(by(r).ed).toMatchObject({ isExported: true, exportStyle: 'esm-named' });
  });

  test('ESM(.mjs): 拡張子ガードで弾かれず抽出できる', async () => {
    const r = await load('esm.mjs');
    expect(names(r)).toEqual(['mjsDefault', 'mjsFn']);
  });

  test('CJS(.cjs): 拡張子ガードで弾かれず抽出できる', async () => {
    const r = await load('cjs_anon.cjs');
    expect(names(r)).toEqual(['default']);
  });
});

describe('getFunction: メタ情報（async / optionKeys）', () => {
  test('async 関数と options キー（分割代入 / opts.key 読み取り）', async () => {
    const r = await load('meta.js');
    const m = by(r);
    // async 関数
    expect(m.fetchData).toMatchObject({ isAsync: true });
    expect(m.fetchData.optionKeys).toEqual(['headers', 'method']); // opts.headers / opts.method
    // 分割代入 object 引数のキー
    expect(m.make).toMatchObject({ isAsync: false });
    expect(m.make.optionKeys).toEqual(['retry', 'timeout']);
  });
});
