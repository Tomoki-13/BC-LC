import { convertExportRemoved } from '../patternGen/converters/exportRemoved';
import { convertFunctionRemoved } from '../patternGen/converters/functionRemoved';
import { convertOptionRemoved } from '../patternGen/converters/optionRemoved';
import { convertArgRemoved } from '../patternGen/converters/argRemoved';
import { convertDeepImportBroken } from '../patternGen/converters/deepImportBroken';
import { convertNodeNpmRequirementRaised } from '../patternGen/converters/nodeNpmRequirementRaised';
import { typeAwarePatternMatch } from '../clientDetect/match/typeAwarePatternMatch';
import { escapeFunc } from '../clientDetect/match/patternToScript';
import { nodeEngineHits } from '../clientDetect/match/nodeEngineMatch';
import fs from 'fs';
import os from 'os';
import pathmod from 'path';
import type { ApiSymbol, ExportStyle, LossCandidate } from '../types/LibDiff';
import type { GeneratedPattern } from '../types/patternTypes';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

const valueSymbol = (name: string, exportStyle: ExportStyle = 'esm-named'): ApiSymbol => ({ name, kind: 'value', exportStyle, filePath: 'index.js' });
const funcSymbol = (name: string, exportStyle: ExportStyle = 'esm-named'): ApiSymbol => ({ name, kind: 'function', exportStyle, filePath: 'index.js', params: ['a'] });
const candidate = (symbol: string, tag: LossCandidate['tag']): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol, filePath: 'index.js', tag, label: 'L', confidence: 'structural',
});

// useAst 抽出結果（1 呼び出し/import）を模す。argTypes.length=引数個数, argContexts=引数ごとの値スニペット
const efcr = (code: string, argTypes: string[][] = [[]], argContexts: string[][] = [[]]): ExtractFunctionCallsResult =>
  ({ FunctionCallCode: code, filePath: 'client.js', line: 0, argTypes, argContexts });
// 1ファイル分の抽出ブロック列（[import, 呼び出し...]）に全パターンを照合
const match = (patterns: GeneratedPattern[], blocks: ExtractFunctionCallsResult[]) => typeAwarePatternMatch(patterns, [blocks]).matched;

describe('escapeFunc: リテラル括弧のみエスケープし正規表現構文は温存', () => {
  test('名前付きグループは無加工、呼び出しの括弧はエスケープ', () => {
    expect(escapeFunc('(?<variable1>[\\w-]+)')).toBe('(?<variable1>[\\w-]+)');
    expect(escapeFunc('variable1\\.foo([^)]*)')).toBe('variable1\\.foo\\([^\\)]*\\)');
  });
  test('否定先読み (?! は温存', () => {
    expect(escapeFunc('(?!await )foo')).toBe('(?!await )foo');
  });
});

describe('export-removed 値 val1 の削除', () => {
  const patterns = convertExportRemoved({ candidate: candidate('val1', 'export-removed'), preSymbol: valueSymbol('val1') });
  test('cjs-require: m.val1 を参照で検出', () => {
    expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.val1')])).toBe(true);
  });
  test('esm-named: import { val1 } は import のみで検出', () => {
    expect(match(patterns, [efcr("import { val1 } from 'lib'")])).toBe(true);
  });
  test('別名 import { val1 as v } も検出', () => {
    expect(match(patterns, [efcr("import { val1 as v } from 'lib'")])).toBe(true);
  });
  test('別の値 val2 の参照は非検出', () => {
    expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.val2')])).toBe(false);
  });
  test('別ライブラリの同名参照は非検出', () => {
    expect(match(patterns, [efcr("const m = require('other')"), efcr('m.val1')])).toBe(false);
  });
});

describe('function-removed func1 の削除', () => {
  const patterns = convertFunctionRemoved({ candidate: candidate('func1', 'function-removed'), preSymbol: funcSymbol('func1') });
  test('const m = require("lib"); m.func1(x) を検出', () => {
    expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(42)', [['unknown']])])).toBe(true);
  });
  test('func1 を呼ばない別ライブラリ利用は非検出', () => {
    expect(match(patterns, [efcr("const m = require('other')"), efcr('m.func1(42)', [['unknown']])])).toBe(false);
  });
});

describe('option-removed opt1 の削除（argContexts/コードのキー判定）', () => {
  const preSym: ApiSymbol = { ...funcSymbol('func1'), optionKeys: ['opt1', 'opt2'] };
  const postSym: ApiSymbol = { ...funcSymbol('func1'), optionKeys: ['opt2'] };
  const patterns = convertOptionRemoved({ candidate: candidate('func1', 'option-removed'), preSymbol: preSym, postSymbol: postSym });

  test('削除キー opt1 を渡す呼び出しを検出（コード/argContexts に opt1）', () => {
    expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(src, { opt1: 4 })', [['unknown'], ['object']], [['src'], ['{ opt1: 4 }']])])).toBe(true);
  });
  test('opts 変数越しでも argContexts の解決値に opt1 があれば検出', () => {
    expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(src, opts)', [['unknown'], ['object']], [['src'], ['{ opt1: 4 }']])])).toBe(true);
  });
  test('残存キー opt2 だけの呼び出しは非検出', () => {
    expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(src, { opt2: 4 })', [['unknown'], ['object']], [['src'], ['{ opt2: 4 }']])])).toBe(false);
  });
  test('options 無しの呼び出しは非検出', () => {
    expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(src)', [['unknown']], [['src']])])).toBe(false);
  });
});

describe('arg-removed: arity を argTypes.length で判定', () => {
  const argCand = (detail: string) => ({ ...candidate('func1', 'arg-removed'), detail });
  const sym = (params: string[]): ApiSymbol => ({ name: 'func1', kind: 'function', exportStyle: 'esm-named', filePath: 'index.js', params });

  describe('中間削除 (a,b,c)→(a,c): minArgs=2', () => {
    const patterns = convertArgRemoved({ candidate: argCand('(a, b, c) → (a, c)'), preSymbol: sym(['a', 'b', 'c']), postSymbol: sym(['a', 'c']) });
    test('argCheck が付与される', () => {
      expect(patterns[0].argCheck).toEqual({ minArgs: 2, changedIndices: [1] });
    });
    test('2引数の呼び出し（argTypes.length=2）を検出', () => {
      expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(x, y)', [['unknown'], ['unknown']])])).toBe(true);
    });
    test('1引数（argTypes.length=1）は非検出', () => {
      expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(x)', [['unknown']])])).toBe(false);
    });
  });

  describe('全削除 (input,offset)→(): minArgs=1', () => {
    const patterns = convertArgRemoved({ candidate: argCand('(input, offset) → ()'), preSymbol: sym(['input', 'offset']), postSymbol: sym([]) });
    test('1引数で検出', () => {
      expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1(x)', [['unknown']])])).toBe(true);
    });
    test('0引数（argTypes.length=0）は非検出', () => {
      expect(match(patterns, [efcr("const m = require('lib')"), efcr('m.func1()', [])])).toBe(false);
    });
  });
});

describe('deep-import-broken（binding のみ・usage 無し）', () => {
  const preSym: ApiSymbol = { name: 'walk', kind: 'value', exportStyle: 'esm-named', filePath: 'util/walk.js' };
  const patterns = convertDeepImportBroken({ candidate: { ...candidate('walk', 'deep-import-broken'), filePath: 'util/walk.js' }, preSymbol: preSym });
  test('require("lib/util/walk") を import だけで検出', () => {
    expect(match(patterns, [efcr("const w = require('lib/util/walk')")])).toBe(true);
  });
  test('別サブパスの import は非検出', () => {
    expect(match(patterns, [efcr("const w = require('lib/util/other')")])).toBe(false);
  });
});

describe('node-npm-requirement-raised: 環境述語の生成とクライアント Node 版照合', () => {
  const patterns = convertNodeNpmRequirementRaised({
    candidate: { ...candidate('engines.node', 'node-npm-requirement-raised'), detail: 'engines.node: (なし) → >=8' },
    preSymbol: { name: 'engines.node', kind: 'unknown', exportStyle: 'unknown', filePath: 'package.json' },
    engines: { pre: {}, post: { node: '>=8' } },
  });
  test('env 述語を1件生成し requiredMin=8.0.0', () => {
    expect(patterns).toHaveLength(1);
    expect(patterns[0].env).toEqual({ kind: 'node-engine', field: 'engines.node', requiredMin: '8.0.0' });
    expect(patterns[0].calls).toEqual([]);
  });

  const mkRepo = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'cd-'));
    for (const [rel, content] of Object.entries(files)) {
      const p = pathmod.join(dir, rel); fs.mkdirSync(pathmod.dirname(p), { recursive: true }); fs.writeFileSync(p, content);
    }
    return dir;
  };
  const env = patterns[0].env!;

  test('.travis.yml が node 6 を含む（<8）→ 壊れると判定', () => {
    expect(nodeEngineHits(env, mkRepo({ '.travis.yml': "language: node_js\nnode_js:\n  - '6'\n  - '8'\n" }))).toBe(true);
  });
  test('.travis.yml が node 10 のみ（>=8）→ 壊れない', () => {
    expect(nodeEngineHits(env, mkRepo({ '.travis.yml': "language: node_js\nnode_js:\n  - '10'\n" }))).toBe(false);
  });
  test('engines.node ">=4"（CI 無し・宣言のみ）→ 4<8 で壊れる', () => {
    expect(nodeEngineHits(env, mkRepo({ 'package.json': JSON.stringify({ engines: { node: '>=4' } }) }))).toBe(true);
  });
  test('記号値のみ（lts/*）・シグナル皆無 → 判別不能で非検出', () => {
    expect(nodeEngineHits(env, mkRepo({ '.travis.yml': "node_js:\n  - lts/*\n" }))).toBe(false);
  });
});
