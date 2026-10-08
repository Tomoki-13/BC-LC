import { convertArgReordered } from '../patternGen/converters/argReordered';
import type { ApiSymbol, ExportStyle, LossCandidate } from '../types/LibDiff';
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

const symbol = (name: string, exportStyle: ExportStyle = 'esm-named'): ApiSymbol =>
  ({ name, kind: 'function', exportStyle, filePath: 'index.js', params: ['a', 'b'] });
const candidate = (symbolName: string): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol: symbolName, filePath: 'index.js',
  tag: 'arg-reordered', label: '引数の並び替え', confidence: 'structural',
});
const anyMatch = (patterns: ReturnType<typeof convertArgReordered>, code: string) =>
  patterns.some(p => matchesClient(p.calls, code));

// ライブラリ例（一般化名）:
//   pre  export function func1(a, b) / post func1(b, a)（同名・順序違い＝位置引数がずれる）
//   関数は残るので「func1 を位置引数で呼んでいる」クライアントを検出
describe('arg-reordered (B) 名前付き func1: 呼び出しを検出', () => {
  const patterns = convertArgReordered({ candidate: candidate('func1'), preSymbol: symbol('func1') });

  test('cjs-require + 呼び出し l.func1(x, y) を検出', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nl.func1(x, y);")).toBe(true);
  });

  test('named import func1(x, y) を検出', () => {
    expect(anyMatch(patterns, "import { func1 } from 'lib';\nfunc1(x, y);")).toBe(true);
  });

  test('別名 import { func1 as f }; f(x, y) を検出', () => {
    expect(anyMatch(patterns, "import { func1 as f } from 'lib';\nf(x, y);")).toBe(true);
  });

  test('参照のみ const g = l.func1; は検出しない（呼び出しでないと壊れない）', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nconst g = l.func1;")).toBe(false);
  });

  test('別関数 l.other(x, y) は検出しない', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nl.other(x, y);")).toBe(false);
  });
});

describe('arg-reordered (A) default が関数: 直接呼びを検出', () => {
  const patterns = convertArgReordered({ candidate: candidate('default'), preSymbol: symbol('default', 'cjs-module-default') });

  test('const F = require("lib"); F(x, y) を検出', () => {
    expect(anyMatch(patterns, "const F = require('lib');\nF(x, y);")).toBe(true);
  });

  test('new F(x, y)（コンストラクタ引数の並び替え）を検出', () => {
    expect(anyMatch(patterns, "import F from 'lib';\nconst o = new F(x, y);")).toBe(true);
  });
});
