import { convertPublishedFileMissing } from '../patternGen/converters/publishedFileMissing';
import { convertFunctionRemoved } from '../patternGen/converters/functionRemoved';
import { convertReturnChanged } from '../patternGen/converters/returnChanged';
import { convertArgRemoved } from '../patternGen/converters/argRemoved';
import { convertDeepImportBroken } from '../patternGen/converters/deepImportBroken';
import { generatePatterns } from '../patternGen/generatePatterns';
import { findPublishedMissing } from '../libDiff/publishedFiles';
import DiffSurface from '../libDiff/diffSurface';
import { typeAwarePatternMatch } from '../clientDetect/match/typeAwarePatternMatch';
import fs from 'fs';
import os from 'os';
import pathmod from 'path';
import type { ApiSurface, ApiSymbol, LossCandidate } from '../types/LibDiff';
import type { GeneratedPattern } from '../types/patternTypes';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

const funcSymbol = (name: string, params = ['a'], filePath = 'index.js'): ApiSymbol =>
  ({ name, kind: 'function', exportStyle: 'cjs-property', filePath, params });
const candidate = (symbol: string, tag: LossCandidate['tag'], extra: Partial<LossCandidate> = {}): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol, filePath: 'index.js', tag, label: 'L', confidence: 'structural', ...extra,
});
const efcr = (code: string, argTypes: string[][] = [[]]): ExtractFunctionCallsResult =>
  ({ FunctionCallCode: code, filePath: 'client.js', line: 0, argTypes, argContexts: argTypes.map(() => []) });
const match = (patterns: GeneratedPattern[], blocks: ExtractFunctionCallsResult[]) => typeAwarePatternMatch(patterns, [blocks]).matched;

// 公開物の欠落: get-value 1.3.0（files: ["index.js"] で utils.js が欠落）と同じ構成を一時ディレクトリに作る
describe('findPublishedMissing: main から辿れる require 先が files 指定から外れているか', () => {
  const makeTree = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'pubmiss-'));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(pathmod.dirname(pathmod.join(dir, rel)), { recursive: true });
      fs.writeFileSync(pathmod.join(dir, rel), body);
    }
    return dir;
  };

  test('files に無い ./utils を main が読む → 欠落', () => {
    const dir = makeTree({
      'package.json': JSON.stringify({ name: 'lib', main: 'index.js', files: ['index.js'] }),
      'index.js': "var utils = require('./utils');",
      'utils.js': 'module.exports = {};',
    });
    expect(findPublishedMissing(dir)).toEqual([{ from: 'index.js', spec: './utils', target: 'utils.js' }]);
  });

  test('ディレクトリ指定 files: ["lib"] なら lib/ 配下は同梱＝欠落なし', () => {
    const dir = makeTree({
      'package.json': JSON.stringify({ name: 'lib', main: 'lib/index.js', files: ['lib'] }),
      'lib/index.js': "module.exports = require('./core');",
      'lib/core.js': 'module.exports = 1;',
    });
    expect(findPublishedMissing(dir)).toEqual([]);
  });

  test('main から辿れないファイル（ベンチマーク等）は対象外', () => {
    const dir = makeTree({
      'package.json': JSON.stringify({ name: 'lib', files: ['index.js'] }),
      'index.js': 'module.exports = 1;',
      'bench/run.js': "require('./helper');",
      'bench/helper.js': '',
    });
    expect(findPublishedMissing(dir)).toEqual([]);
  });

  test('files 指定が無ければ判定しない（undefined）', () => {
    const dir = makeTree({ 'package.json': JSON.stringify({ name: 'lib' }), 'index.js': "require('./x');", 'x.js': '' });
    expect(findPublishedMissing(dir)).toBeUndefined();
  });
});

describe('diffSurface: post で新たに欠落したときだけ published-file-missing を出す', () => {
  const surface = (version: string, publishedMissing?: ApiSurface['publishedMissing']): ApiSurface =>
    ({ version, tag: version, scope: 'export', symbols: [funcSymbol('f')], publishedMissing });
  const miss = [{ from: 'index.js', spec: './utils', target: 'utils.js' }];

  test('pre に無く post で欠落 → 候補', () => {
    const tags = DiffSurface.diffSurface(surface('1.0.0', []), surface('2.0.0', miss), 'lib').map(c => c.tag);
    expect(tags).toContain('published-file-missing');
  });
  test('pre から既に欠落（同じファイル）→ 候補にしない', () => {
    const tags = DiffSurface.diffSurface(surface('1.0.0', miss), surface('2.0.0', miss), 'lib').map(c => c.tag);
    expect(tags).not.toContain('published-file-missing');
  });
});

describe('published-file-missing: ライブラリ本体の読み込みなら記法を問わず検出', () => {
  const patterns = convertPublishedFileMissing({ candidate: candidate('(package)', 'published-file-missing'), preSymbol: funcSymbol('(package)') });

  test.each([
    "var get = require('lib')",
    "require('lib', 'get')",                // lazy-cache
    "const flatten = require('lib').flatten",
    "import x from 'lib'",
    "import 'lib'",
    "const m = await import('lib')",
  ])('%s', (code) => {
    expect(match(patterns, [efcr(code)])).toBe(true);
  });

  test('サブパス lib/sub と別ライブラリ lib-x は非検出', () => {
    expect(match(patterns, [efcr("require('lib/sub')")])).toBe(false);
    expect(match(patterns, [efcr("require('lib-x')")])).toBe(false);
  });
});

describe("require('lib').NAME の形", () => {
  test('function-removed: const f = require("lib").flatten は binding だけで検出、.flatten.x のチェーンは除く', () => {
    const patterns = convertFunctionRemoved({ candidate: candidate('flatten', 'function-removed'), preSymbol: funcSymbol('flatten') });
    expect(match(patterns, [efcr("const f = require('lib').flatten")])).toBe(true);
    expect(match(patterns, [efcr("foo(require('lib').flatten)")])).toBe(true);
    expect(match(patterns, [efcr("const f = require('lib').flattenDeep")])).toBe(false);
  });

  test('return-changed: 束縛した変数の呼び出し f(x) と、その場の呼び出し require("lib").flatten(x) を検出', () => {
    const patterns = convertReturnChanged({ candidate: candidate('flatten', 'return-changed'), preSymbol: funcSymbol('flatten') });
    expect(match(patterns, [efcr("const f = require('lib').flatten"), efcr('f(arr)')])).toBe(true);
    expect(match(patterns, [efcr("const out = require('lib').flatten(arr)")])).toBe(true);
    expect(match(patterns, [efcr("const f = require('lib').flatten")])).toBe(false); // 束縛だけで呼んでいない
  });

  test('arg-removed: 引数個数を見られないその場の呼び出しはパターンにしない', () => {
    const patterns = convertArgRemoved({
      candidate: candidate('flatten', 'arg-removed'), preSymbol: funcSymbol('flatten', ['a', 'b']), postSymbol: funcSymbol('flatten', ['a']),
    });
    expect(patterns.some(p => p.importForm === 'cjs-require-member-inline')).toBe(false);
    expect(match(patterns, [efcr("const f = require('lib').flatten"), efcr('f(x, y)', [['unknown'], ['unknown']])])).toBe(true);
    expect(match(patterns, [efcr("const f = require('lib').flatten"), efcr('f(x)', [['unknown']])])).toBe(false);
  });
});

describe('deep-import-broken: ディレクトリごと消えたら配下すべてへの deep import を検出', () => {
  const base = { candidate: candidate('util/walk', 'deep-import-broken', { filePath: 'util/walk.js', goneDir: 'util' }), preSymbol: funcSymbol('walk', ['a'], 'util/walk.js') };
  const patterns = convertDeepImportBroken(base);

  test('消えたファイルと同じディレクトリの別ファイル・ディレクトリ自身も検出', () => {
    expect(match(patterns, [efcr("var walk = require('lib/util/walk')")])).toBe(true);
    expect(match(patterns, [efcr("var other = require('lib/util/other')")])).toBe(true);
    expect(match(patterns, [efcr("import u from 'lib/util'")])).toBe(true);
  });
  test('名前が前方一致するだけの別ディレクトリ lib/utils は非検出', () => {
    expect(match(patterns, [efcr("var u = require('lib/utils/x')")])).toBe(false);
  });
  test('goneDir が無ければファイル単位のみ（同じディレクトリの別ファイルは非検出）', () => {
    const fileOnly = convertDeepImportBroken({ ...base, candidate: candidate('util/walk', 'deep-import-broken', { filePath: 'util/walk.js' }) });
    expect(match(fileOnly, [efcr("var other = require('lib/util/other')")])).toBe(false);
  });
});

describe('diffSurface: goneDir はディレクトリ配下の export ファイルが post に1つも無いときだけ付く', () => {
  const surf = (version: string, files: string[]): ApiSurface =>
    ({ version, tag: version, scope: 'export', symbols: files.map(f => ({ name: pathmod.basename(f, '.js'), kind: 'function', exportStyle: 'cjs-module-default', filePath: f, params: [] })) });

  test('src/util/ が丸ごと消えた → goneDir=util（src/ は外す）', () => {
    const c = DiffSurface.diffSurface(surf('1', ['index.js', 'src/util/a.js', 'src/util/b.js']), surf('2', ['index.js']), 'lib');
    expect(c.filter(x => x.tag === 'module-removed').map(x => x.goneDir)).toEqual(['util', 'util']);
  });
  test('同じディレクトリに残るファイルがある → goneDir なし', () => {
    const c = DiffSurface.diffSurface(surf('1', ['src/util/a.js', 'src/util/b.js']), surf('2', ['src/util/b.js']), 'lib');
    expect(c.filter(x => x.tag === 'module-removed').map(x => x.goneDir)).toEqual([undefined]);
  });
  test('同じディレクトリから消えた2ファイルのディレクトリ単位パターンは generatePatterns で1組にまとまる', () => {
    const pre = surf('1', ['index.js', 'src/util/a.js', 'src/util/b.js']);
    const c = DiffSurface.diffSurface(pre, surf('2', ['index.js']), 'lib');
    const { patterns } = generatePatterns(c, pre, undefined);
    const dirForms = patterns.filter(p => p.importForm.endsWith(':util/*'));
    expect(dirForms.length).toBe(4); // require / from / bare import / dynamic import の4記法
  });
});
