import { convertDeepImportBroken } from '../patternGen/converters/deepImportBroken';
import type { ApiSymbol, LossCandidate } from '../types/LibDiff';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

// 生成パターン(stored 形式)を実行可能な RegExp へ（R-BC patternToScript 相当の簡易版・括弧をエスケープ）
function scriptify(storedRegex: string): string {
  const saved: string[] = [];
  let s = storedRegex.replace(/\(\?<[\w-]+>\[\\w-\]\+\)/g, (m) => {
    saved.push(m);
    return `@@${saved.length - 1}@@`;
  });
  s = s.replace(/[()]/g, (ch) => `\\${ch}`);
  return s.replace(/@@(\d+)@@/g, (_, i) => saved[Number(i)]);
}

// binding のみのパターンなので calls[0] を照合するだけ
const matches = (calls: ExtractFunctionCallsResult[], code: string) =>
  new RegExp(scriptify(calls[0].FunctionCallCode), 'm').test(code);
const anyMatch = (patterns: ReturnType<typeof convertDeepImportBroken>, code: string) =>
  patterns.some(p => matches(p.calls, code));

const symbol = (name: string, filePath: string): ApiSymbol => ({ name, kind: 'function', exportStyle: 'esm-named', filePath });
const candidate = (name: string, filePath: string): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol: name, filePath,
  tag: 'deep-import-broken', label: '内部パス移動', confidence: 'structural',
});

// ライブラリ例（一般化名）:
//   pre  lib/func1.js が func1 を定義（client は require('lib/func1') で deep import）
//   post func1 が lib/core/func1.js へ移動（名前は残るがファイルが変わり旧 deep import が壊れる）
describe('deep-import-broken: 移動前サブパス lib/func1 の deep import を検出（binding のみ）', () => {
  const patterns = convertDeepImportBroken({ candidate: candidate('func1', 'lib/func1.js'), preSymbol: symbol('func1', 'lib/func1.js') });

  test('usage を持たず binding のみ', () => {
    expect(patterns.every(p => p.calls.length === 1)).toBe(true);
  });

  test('require("lib/func1") / import ... from "lib/func1" を検出', () => {
    expect(anyMatch(patterns, "const f = require('lib/func1');")).toBe(true);
    expect(anyMatch(patterns, "import f from 'lib/func1';")).toBe(true);
    expect(anyMatch(patterns, "import { func1 } from 'lib/func1';")).toBe(true);
  });

  test('トップレベル require("lib") は検出しない（名前は再 export され壊れない）', () => {
    expect(anyMatch(patterns, "const l = require('lib');")).toBe(false);
  });

  test('別サブパス lib/other は検出しない', () => {
    expect(anyMatch(patterns, "const o = require('lib/other');")).toBe(false);
  });
});

// サブディレクトリ付きのパス（src/ は公開サブパスから外れる想定）: ファイル由来と名前由来の両サブパスを出す
describe('deep-import-broken: src/ を剥がしファイル由来と名前由来の両サブパスを検出', () => {
  const patterns = convertDeepImportBroken({ candidate: candidate('parse', 'src/util/parse.js'), preSymbol: symbol('parse', 'src/util/parse.js') });

  test('ファイル由来 lib/util/parse と 名前由来 lib/parse の両方を検出', () => {
    expect(anyMatch(patterns, "const p = require('lib/util/parse');")).toBe(true);
    expect(anyMatch(patterns, "const p = require('lib/parse');")).toBe(true);
  });
});
