import { convertSyncToAsync } from '../patternGen/converters/syncToAsync';
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
  ({ name, kind: 'function', exportStyle, filePath: 'index.js', isAsync: true });
const candidate = (symbolName: string): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol: symbolName, filePath: 'index.js',
  tag: 'sync-to-async', label: '同期→非同期の変化', confidence: 'structural', detail: 'sync → async',
});
const anyMatch = (patterns: ReturnType<typeof convertSyncToAsync>, code: string) =>
  patterns.some(p => matchesClient(p.calls, code));

// ライブラリ例（一般化名）:
//   pre  export function func1() {...}（同期）/ post async function func1() {...}（非同期化）
//   関数は残るので「func1 を呼んでいる」クライアントを検出（await 有無は regex で絞れないため広く検出）
describe('sync-to-async (B) 名前付き func1: 呼び出しを検出（await 有無不問）', () => {
  const patterns = convertSyncToAsync({ candidate: candidate('func1'), preSymbol: symbol('func1') });

  test('await 無しの呼び出し l.func1() を検出（sync→async で壊れる側）', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nconst x = l.func1();")).toBe(true);
  });

  test('await 付きの呼び出しも検出する（絞れないため。安全な側だが FP として拾う）', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nconst x = await l.func1();")).toBe(true);
  });

  test('named import func1() を検出', () => {
    expect(anyMatch(patterns, "import { func1 } from 'lib';\nfunc1();")).toBe(true);
  });

  test('参照のみ const g = l.func1; は検出しない', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nconst g = l.func1;")).toBe(false);
  });

  test('別関数 l.other() は検出しない', () => {
    expect(anyMatch(patterns, "const l = require('lib');\nl.other();")).toBe(false);
  });
});
