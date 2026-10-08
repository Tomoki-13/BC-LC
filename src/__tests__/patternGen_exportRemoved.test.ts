import { convertExportRemoved } from '../patternGen/converters/exportRemoved';
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

// binding→usage の2段照合を再現（usage が無いパターンは binding のみで判定）
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

const valueSymbol = (name: string, exportStyle: ExportStyle = 'esm-named'): ApiSymbol => ({ name, kind: 'value', exportStyle, filePath: 'index.js' });
const candidate = (symbol: string, tag: LossCandidate['tag']): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol, filePath: 'index.js',
  tag, label: 'L', confidence: 'structural',
});
const anyMatch = (patterns: ReturnType<typeof convertExportRemoved>, code: string) =>
  patterns.some(p => matchesClient(p.calls, code));

// ライブラリ例（一般化名）:
//   pre  export const val1 = {...}
//   post val1 を削除（非関数 export の削除）
// クライアントは val1 を参照していると壊れる → それを検出できるか
describe('export-removed (B) 名前付き値 val1 の削除', () => {
  const patterns = convertExportRemoved({ candidate: candidate('val1', 'export-removed'), preSymbol: valueSymbol('val1') });

  test('cjs-require: const m = require("lib"); m.val1 を検出（値は参照して使う＝これが使用）', () => {
    expect(anyMatch(patterns, "const m = require('lib');\nconst d = m.val1;")).toBe(true);
  });

  test('esm-named: import { val1 } from "lib" は削除名を直接 import しているだけで検出（usage 不要）', () => {
    expect(anyMatch(patterns, "import { val1 } from 'lib';")).toBe(true);
  });

  test('別名 import { val1 as v } from "lib" も import だけで検出', () => {
    expect(anyMatch(patterns, "import { val1 as v } from 'lib';")).toBe(true);
  });

  test('別の値 val2 を参照するだけなら検出しない', () => {
    expect(anyMatch(patterns, "const m = require('lib');\nconst d = m.val2;")).toBe(false);
  });

  test('別ライブラリの同名参照は検出しない', () => {
    expect(anyMatch(patterns, "const m = require('other');\nconst d = m.val1;")).toBe(false);
  });
});

// ライブラリ例:
//   pre  export default CONFIG（default が値）
//   post default を削除
describe('export-removed (A) default 値 の削除', () => {
  const patterns = convertExportRemoved({ candidate: candidate('default', 'export-removed'), preSymbol: valueSymbol('default', 'esm-default') });

  test('import C from "lib"; C を参照して検出（.default ではなく束縛そのもの）', () => {
    expect(anyMatch(patterns, "import C from 'lib';\nconst d = C.timeout;")).toBe(true);
  });

  test('babel interop const C = require("lib"); C.default を参照して検出', () => {
    expect(anyMatch(patterns, "const C = require('lib');\nconst d = C.default;")).toBe(true);
  });
});
