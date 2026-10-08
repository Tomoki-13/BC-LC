import { convertFunctionRemoved } from '../patternGen/converters/functionRemoved';
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

// binding→usage の2段照合を再現: binding で変数名を捕捉し、usage 内の variable1 を実名に置換して照合
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

const symbol = (name: string, exportStyle: ExportStyle = 'esm-named'): ApiSymbol => ({ name, kind: 'function', exportStyle, filePath: 'index.js' });
const candidate = (libName: string, symbolName: string): LossCandidate => ({
  libName, preVersion: '7.0.0', postVersion: '8.0.0', symbol: symbolName, filePath: 'index.js',
  tag: 'function-removed', label: 'export 関数の削除', confidence: 'structural',
});
// あるクライアントコードを1つでも命中させるパターンがあるか
const anyMatch = (patterns: ReturnType<typeof convertFunctionRemoved>, code: string) =>
  patterns.some(p => matchesClient(p.calls, code));

describe('function-removed (B) 名前付き/プロパティ関数: globby.sync 削除', () => {
  const patterns = convertFunctionRemoved({ candidate: candidate('globby', 'sync'), preSymbol: symbol('sync') });
  const byForm = (form: string) => patterns.find(p => p.importForm === form)!;

  test('label/tag を候補から引き継ぐ', () => {
    expect(patterns.every(p => p.tag === 'function-removed' && p.label === 'export 関数の削除')).toBe(true);
  });

  test('cjs-require + 呼び出し g.sync([...]) を検出（引数内ドットも取りこぼさない）', () => {
    expect(matchesClient(byForm('cjs-require').calls, "const g = require('globby');\ng.sync(['src/**/*.js']);")).toBe(true);
  });

  test('参照のみ const f = g.sync; も検出（呼び出しに限らない）', () => {
    expect(matchesClient(byForm('cjs-require').calls, "const g = require('globby');\nconst f = g.sync;")).toBe(true);
  });

  test('esm-named import { sync } from "globby" は import しているだけで検出（usage 不要）', () => {
    expect(matchesClient(byForm('esm-named').calls, "import { sync } from 'globby';")).toBe(true);
  });

  test('別名 import { sync as s } from "globby" も import だけで検出', () => {
    expect(anyMatch(patterns, "import { sync as s } from 'globby';")).toBe(true);
  });

  test('別関数 g.gitignore(...) のみは検出しない', () => {
    expect(anyMatch(patterns, "const g = require('globby');\ng.gitignore(['*.js']);")).toBe(false);
  });

  test('別ライブラリ fast-glob の同名 .sync は検出しない', () => {
    expect(anyMatch(patterns, "const g = require('fast-glob');\ng.sync(['*.js']);")).toBe(false);
  });
});

describe('function-removed (A) default が関数/クラスそのもの: vinyl default 削除', () => {
  const patterns = convertFunctionRemoved({ candidate: candidate('vinyl', 'default'), preSymbol: symbol('default', 'cjs-module-default') });

  test('直接呼び const V = require("vinyl"); V(...) を検出（.default( ではない）', () => {
    expect(anyMatch(patterns, "const V = require('vinyl');\nconst f = V({ path: 'a.js' });")).toBe(true);
  });

  test('new V(...) を検出', () => {
    expect(anyMatch(patterns, "import Vinyl from 'vinyl';\nconst f = new Vinyl({ path: 'a.js' });")).toBe(true);
  });

  test('babel interop V.default(...) を検出', () => {
    expect(anyMatch(patterns, "const V = require('vinyl');\nconst f = V.default({ path: 'a.js' });")).toBe(true);
  });

  test('別ライブラリの直接呼びは検出しない', () => {
    expect(anyMatch(patterns, "const V = require('other');\nconst f = V({ path: 'a.js' });")).toBe(false);
  });
});
