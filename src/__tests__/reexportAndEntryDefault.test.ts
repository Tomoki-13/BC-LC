import fs from 'fs';
import os from 'os';
import path from 'path';
import apiSurface from '../libDiff/apiSurface';
import DiffSurface from '../libDiff/diffSurface';
import { generatePatterns } from '../patternGen/generatePatterns';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

const DIR = './src/__tests__/inputFiles/reexportForms';

// getAllFiles は __tests__ 以下を除くので、一時フォルダに写して読む
const surfaceOf = async (dir: string, version = '1.0.0'): Promise<ApiSurface> => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'bclc-reexport-'));
  fs.cpSync(`${DIR}/${dir}`, tree, { recursive: true });
  const s = await apiSurface.buildApiSurface(tree, version, version);
  fs.rmSync(tree, { recursive: true, force: true });
  return s;
};
const find = (s: ApiSurface, file: string, name: string) => s.symbols.find(x => x.filePath === file && x.name === name);

// 生成パターン(stored 形式)を実行可能な RegExp へ（patternGen_exportRemoved.test.ts と同じ簡易版）
function scriptify(storedRegex: string): string {
  const saved: string[] = [];
  let s = storedRegex.replace(/\(\?<[\w-]+>\[\\w-\]\+\)/g, (m) => {
    saved.push(m);
    return `@@${saved.length - 1}@@`;
  });
  s = s.replace(/[()]/g, (ch) => `\\${ch}`);
  return s.replace(/@@(\d+)@@/g, (_, i) => saved[Number(i)]);
}
function matchesClient(calls: ExtractFunctionCallsResult[], clientCode: string): boolean {
  const binding = clientCode.match(new RegExp(scriptify(calls[0].FunctionCallCode), 'm'));
  if (!binding) return false;
  const varName = binding.groups?.variable1;
  for (let i = 1; i < calls.length; i++) {
    let usage = calls[i].FunctionCallCode;
    if (varName) usage = usage.replace(/variable1/g, varName);
    if (!new RegExp(scriptify(usage), 'm').test(clientCode)) return false;
  }
  return true;
}

describe('apiSurface: 相対パスの読み込みをそのまま公開する値を定義元へたどる', () => {
  test('uuid.v1 = v1（var v1 = require(./v1)）・module.exports = uuid（uuid = v4）', async () => {
    const s = await surfaceOf('cjsPre');
    expect(find(s, 'index.js', 'v1')).toMatchObject({ kind: 'function', params: ['options', 'buf', 'offset'], resolvedFrom: 'v1.js#default', exportStyle: 'cjs-property' });
    expect(find(s, 'index.js', 'default')).toMatchObject({ kind: 'function', resolvedFrom: 'v4.js#default', exportStyle: 'cjs-module-default' });
    expect(s.entryFile).toBe('index.js');
  });

  test('export { default as v1 } from ./v1.js・main がビルド成果物なら src/index を入口にする', async () => {
    const s = await surfaceOf('esmPost');
    expect(find(s, 'src/index.js', 'v1')).toMatchObject({ kind: 'function', resolvedFrom: 'src/v1.js#default', exportStyle: 'esm-reexport' });
    expect(s.entryFile).toBe('src/index.js');
  });

  test('module.exports = exports = require(./promise)（連鎖代入）', async () => {
    const s = await surfaceOf('chained');
    expect(find(s, 'lib/index.js', 'default')).toMatchObject({ kind: 'function', params: ['resolver'], resolvedFrom: 'lib/promise.js#default' });
    expect(find(s, 'lib/index.js', 'all')).toMatchObject({ kind: 'function', resolvedFrom: 'lib/all.js#default' });
  });

  test('import してから export { v1, h as helper } / export default v1', async () => {
    const s = await surfaceOf('esmLocal');
    expect(find(s, 'index.js', 'v1')).toMatchObject({ kind: 'function', resolvedFrom: 'v1.js#default' });
    expect(find(s, 'index.js', 'helper')).toMatchObject({ kind: 'function', params: ['a', 'b'], resolvedFrom: 'util.js#helper' });
    expect(find(s, 'index.js', 'default')).toMatchObject({ kind: 'function', resolvedFrom: 'v1.js#default' });
  });
});

describe('diffSurface: 入口ファイルの default の削除（entry-default-removed）', () => {
  test('CJS の入口 → ESM の入口（default なし）: 署名の同じ v1・v4 は損失にせず、入口の default の削除を出す', async () => {
    const pre = await surfaceOf('cjsPre', '1.0.0');
    const post = await surfaceOf('esmPost', '2.0.0');
    const c = DiffSurface.diffSurface(pre, post, 'uuid');
    // v1.js → src/v1.js の移動（uuid/v1 の deep import が壊れる）は出るが、引数・返り値の変化は出ない
    expect(c.filter(x => ['v1', 'v4'].includes(x.symbol)).map(x => x.tag)).toEqual(['deep-import-broken', 'deep-import-broken']);
    const entry = c.filter(x => x.tag === 'entry-default-removed');
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ symbol: 'default', filePath: 'index.js', entryEsm: true });

    const pats = generatePatterns(c, pre, post).patterns.filter(p => p.tag === 'entry-default-removed');
    const hit = (code: string) => pats.some(p => matchesClient(p.calls, code));
    expect(hit("import uuid from 'uuid';\nuuid.v4();")).toBe(true);           // ESM の default import は参照だけで壊れる
    expect(hit("const uuid = require('uuid');\nuuid();")).toBe(true);          // default を呼ぶ形
    expect(hit("const uuid = require('uuid');\nconst id = uuid.v4();")).toBe(false); // require の v4 は残る
  });

  test('CJS の入口が module.exports = {…} になる: 呼ぶ形だけを検出する', async () => {
    const pre = await surfaceOf('cjsPre', '1.0.0');
    const post = await surfaceOf('cjsObjPost', '2.0.0');
    const c = DiffSurface.diffSurface(pre, post, 'uuid');
    expect(c.find(x => x.tag === 'entry-default-removed')).toMatchObject({ entryEsm: false });
    const pats = generatePatterns(c, pre, post).patterns.filter(p => p.tag === 'entry-default-removed');
    const hit = (code: string) => pats.some(p => matchesClient(p.calls, code));
    expect(hit("import uuid from 'uuid';\nuuid();")).toBe(true);
    expect(hit("import uuid from 'uuid';\nconst id = uuid.v4();")).toBe(false);
  });

  test('入口に default が残るときは出さない', async () => {
    const pre = await surfaceOf('cjsPre', '1.0.0');
    const post = await surfaceOf('cjsPre', '2.0.0');
    expect(DiffSurface.diffSurface(pre, post, 'uuid').filter(x => x.tag === 'entry-default-removed')).toEqual([]);
  });
});

describe('diffSurface: return-changed は文字列の引用符の違いを無視する', () => {
  const surf = (returnExprs: string[]): ApiSurface =>
    ({ version: '1', tag: 'v1', scope: 'export', symbols: [{ name: 'default', exportStyle: 'cjs-module-default', filePath: 'index.js', kind: 'function', params: ['x'], returnExprs } as ApiSymbol] });

  test('"object" → \'object\'（is-object 1.0.1→1.0.2）は損失にしない', () => {
    expect(DiffSurface.diffSurface(surf(['typeof x === "object" && x !== null']), surf(["typeof x === 'object' && x !== null"]), 'lib')).toEqual([]);
  });

  test('`a` → \'a\' も同じ・中身が変われば return-changed', () => {
    expect(DiffSurface.diffSurface(surf(['`a`']), surf(["'a'"]), 'lib')).toEqual([]);
    expect(DiffSurface.diffSurface(surf(['"a"']), surf(["'b'"]), 'lib').map(c => c.tag)).toEqual(['return-changed']);
  });
});
