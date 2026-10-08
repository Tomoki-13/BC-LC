import { convertModuleRemoved } from '../patternGen/converters/moduleRemoved';
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
const anyMatch = (patterns: ReturnType<typeof convertModuleRemoved>, code: string) =>
  patterns.some(p => matches(p.calls, code));

const symbol = (name: string): ApiSymbol => ({ name, kind: 'unknown', exportStyle: 'unknown', filePath: 'sub.js' });
const candidate = (subpath: string): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol: subpath, filePath: 'sub.js',
  tag: 'module-removed', label: 'モジュールの削除', confidence: 'structural',
});

// ライブラリ例（一般化名）:
//   pre  lib/sub がサブモジュールとして存在 / post lib/sub を削除（lib 本体は残る）
describe('module-removed: 消えたサブモジュール lib/sub の import を検出（binding のみ）', () => {
  const patterns = convertModuleRemoved({ candidate: candidate('sub'), preSymbol: symbol('sub') });

  test('usage を持たず binding のみ', () => {
    expect(patterns.every(p => p.calls.length === 1)).toBe(true);
  });

  test('require("lib/sub") / import ... from "lib/sub" を各記法で検出', () => {
    expect(anyMatch(patterns, "const s = require('lib/sub');")).toBe(true);
    expect(anyMatch(patterns, "import s from 'lib/sub';")).toBe(true);
    expect(anyMatch(patterns, "import { a } from 'lib/sub';")).toBe(true);
    expect(anyMatch(patterns, "import * as s from 'lib/sub';")).toBe(true);
    expect(anyMatch(patterns, "import 'lib/sub';")).toBe(true);
  });

  test('lib 本体の import は検出しない（サブモジュールが消えても lib は残る）', () => {
    expect(anyMatch(patterns, "const l = require('lib');")).toBe(false);
  });

  test('別のサブパス lib/other は検出しない', () => {
    expect(anyMatch(patterns, "const o = require('lib/other');")).toBe(false);
  });
});
