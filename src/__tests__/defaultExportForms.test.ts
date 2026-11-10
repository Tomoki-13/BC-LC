import fs from 'fs';
import os from 'os';
import path from 'path';
import { getFunction } from '../astRelated/trace/getFunction';
import apiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import type { ExtendedFunctionMetaInfo } from '../types/FunctionInfo';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

// default で公開される関数・クラスを、関数（kind・引数つき）として取れるか
const DIR = './src/__tests__/inputFiles/defaultForms';
const load = (file: string) => getFunction(`${DIR}/${file}`, 0);
const by = (r: ExtendedFunctionMetaInfo[]) => Object.fromEntries(r.map(f => [f.name, f]));

describe('getFunction: default export の形', () => {
  test('module.exports = function name () {}（名前つきの関数式）', async () => {
    const r = await load('cjs_named_fn_expr.js');
    expect(by(r).serialize).toMatchObject({ isExported: true, arg: ['obj', 'options'], exportStyle: 'cjs-module-default', kind: 'function' });
  });

  test('module.exports = X = function () {}（連鎖代入）', async () => {
    const r = await load('cjs_chained.js');
    expect(by(r).Symbol).toMatchObject({ isExported: true, arg: ['description'], exportStyle: 'cjs-module-default' });
  });

  test('module.exports = exports = X（exports は名前にしない）', async () => {
    const r = await load('cjs_chained_exports.js');
    expect(by(r).ConsoleReporter).toMatchObject({ isExported: true, arg: ['options'], exportStyle: 'cjs-module-default' });
  });

  test('export default 識別子（実体はアロー関数）', async () => {
    const r = await load('esm_default_id.js');
    expect(by(r).arrayUnion).toMatchObject({ isExported: true, arg: ['...arguments_'], exportStyle: 'esm-default' });
  });

  test('export default function () {}（無名）', async () => {
    const r = await load('esm_default_anon.js');
    expect(by(r).default).toMatchObject({ isExported: true, arg: ['input', 'options'], exportStyle: 'esm-default' });
  });

  test('class X {}; module.exports = X（クラス・引数は constructor）', async () => {
    const r = await load('cjs_class_default.js');
    expect(by(r).SyntaxError).toMatchObject({ isExported: true, arg: ['err'], exportStyle: 'cjs-module-default', kind: 'class' });
  });

  test('module.exports = require(…)（値）は関数にしない', async () => {
    const r = await load('cjs_value_default.js');
    expect(r).toEqual([]);
  });
});

describe('diffSurface: 片方が値（kind=value）のときは署名を比べない', () => {
  const surf = (s: Partial<ApiSymbol>): ApiSurface =>
    ({ version: '1', tag: 'v1', scope: 'export', symbols: [{ name: 'default', exportStyle: 'cjs-module-default', filePath: 'index.js', kind: 'function', ...s } as ApiSymbol] });

  test('default が関数 → require の再 export（値）でも arg-removed・return-changed を出さない', () => {
    const pre = surf({ kind: 'function', params: ['req'], returnExprs: ['new Accepts(req)'] });
    const post = surf({ kind: 'value', params: [], returnExprs: [] });
    expect(DiffSurface.diffSurface(pre, post, 'lib').map(c => c.tag)).toEqual([]);
  });

  test('localName が変わっても default どうしで比べる（名前の変更は損失にしない）', () => {
    const pre = surf({ localName: 'Accepts', params: ['req'] });
    const post = surf({ localName: 'accepts', params: ['req'] });
    expect(DiffSurface.diffSurface(pre, post, 'lib')).toEqual([]);
  });
});

describe('apiSurface: default の関数は default の1記号にする', () => {
  // getAllFiles は __tests__ 以下を除くので、一時フォルダに写して読む
  const surfaceOf = async (dir: string) => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'bclc-default-'));
    fs.cpSync(`${DIR}/${dir}`, tree, { recursive: true });
    const s = await apiSurface.buildApiSurface(tree, '1.0.0', '1.0.0');
    fs.rmSync(tree, { recursive: true, force: true });
    return s;
  };

  test('default と名前の両方で公開（module.exports = v4; module.exports.v4 = v4）は両方の記号を持つ', async () => {
    const s = await surfaceOf('dualTree');
    const byName = Object.fromEntries(s.symbols.map(x => [x.name, x]));
    expect(byName.default).toMatchObject({ kind: 'function', localName: 'v4', params: ['family'], exportStyle: 'cjs-module-default' });
    expect(byName.v4).toMatchObject({ kind: 'function', exportStyle: 'cjs-property' });
    expect(byName.v6).toMatchObject({ kind: 'function', exportStyle: 'cjs-property' });
  });

  test('元の名前は localName に残り、value の default は作らない', async () => {
    const s = await surfaceOf('surfaceTree');
    const idx = s.symbols.filter(x => x.filePath === 'index.js');
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ name: 'default', localName: 'Accepts', kind: 'function', params: ['req'], exportStyle: 'cjs-module-default' });

    const named = s.symbols.filter(x => x.filePath === 'lib/named.js');
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ name: 'default', localName: 'normalize', kind: 'function', params: ['file', 'opts'] });
  });
});
