import { convertReturnChanged } from '../patternGen/converters/returnChanged';
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
  ({ name, kind: 'function', exportStyle, filePath: 'index.js' });
const candidate = (symbolName: string): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol: symbolName, filePath: 'index.js',
  tag: 'return-changed', label: '返り値・仕様の変更', confidence: 'semantic', detail: 'return: [a] → [b]',
});
const anyMatch = (patterns: ReturnType<typeof convertReturnChanged>, code: string) =>
  patterns.some(p => matchesClient(p.calls, code));

// ライブラリ例（一般化名）:
//   pre  export function func1() { return a } / post { return b }（同一シグネチャで返り値が変化）
//   返り値を使うクライアントが壊れる。返り値使用の有無は regex で見られないため呼び出しを広く検出
describe('return-changed: 呼び出しを検出（confidence=semantic を引き継ぐ）', () => {
  const patterns = convertReturnChanged({ candidate: candidate('func1'), preSymbol: symbol('func1') });

  test('confidence=semantic を候補から引き継ぐ', () => {
    expect(patterns.every(p => p.confidence === 'semantic' && p.tag === 'return-changed')).toBe(true);
  });

  test('cjs-require + 呼び出し const x = l.func1() を検出', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nconst x = l.func1();")).toBe(true);
  });

  test('named import func1() を検出', () => {
    expect(anyMatch(patterns, "import { func1 } from 'lib';\nconst x = func1();")).toBe(true);
  });

  test('参照のみ const g = l.func1; は検出しない', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nconst g = l.func1;")).toBe(false);
  });

  test('別関数 l.other() は検出しない', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nl.other();")).toBe(false);
  });
});
