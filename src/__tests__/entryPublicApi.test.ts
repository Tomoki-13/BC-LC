import DiffSurface from '../libDiff/diffSurface';
import { resolveEntryFile } from '../libDiff/apiSurface';
import { computeUnpublishedFiles } from '../libDiff/publishedFiles';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

const sym = (name: string, over: Partial<ApiSymbol> = {}): ApiSymbol =>
  ({ name, kind: 'function', exportStyle: 'cjs-property', filePath: 'index.js', params: [], returnExprs: [], ...over });
const surface = (symbols: ApiSymbol[], extra: Partial<ApiSurface> = {}): ApiSurface =>
  ({ version: '1', tag: 'v1', scope: 'export', symbols, entryFile: 'index.js', ...extra });
const tagsOf = (pre: ApiSurface, post: ApiSurface) =>
  DiffSurface.diffSurface(pre, post, 'lib').map(c => `${c.tag}:${c.symbol}:${c.filePath}`);

describe('diffSurface: 入口の公開名で比べる', () => {
  test('入口でないファイルの関数の削除・返り値の変化は名前ごとには出さない（ファイルが消えたら module-removed だけ）', () => {
    const pre = surface([sym('v4'), sym('default', { filePath: 'lib/rng.js', returnExprs: ['rb(16)'] }), sym('whatwgRNG', { filePath: 'lib/rng-browser.js' })]);
    const post = surface([sym('v4'), sym('default', { filePath: 'lib/rng.js', returnExprs: ['crypto.randomBytes(16)'] })]);
    expect(tagsOf(pre, post)).toEqual(['module-removed:rng-browser:lib/rng-browser.js']);
  });

  test('入口から消えた名前は、別のファイルに同じ名前が残っていても削除', () => {
    const pre = surface([sym('installMethod'), sym('other')]);
    const post = surface([sym('other'), sym('installMethod', { filePath: 'lib/plugins.js' })]);
    expect(tagsOf(pre, post)).toEqual(['function-removed:installMethod:index.js']);
  });

  test('入口の公開名どうしで署名を比べる（再公開をたどった定義のファイルが変わっても同じ名前なら比べる）', () => {
    const pre = surface([sym('dest', { accessPath: 'vfs.dest', optionKeys: ['cwd', 'mode'], resolvedFrom: 'lib/dest.js#default' })]);
    const post = surface([sym('dest', { optionKeys: ['cwd'], resolvedFrom: 'lib/dest/index.js#default' })]);
    expect(tagsOf(pre, post)).toEqual(['option-removed:dest:index.js']);
  });

  test('accessPath がプロパティ名だけ（createStream）でも公開名は記号の名前', () => {
    const pre = surface([sym('createStream', { accessPath: 'createStream' })]);
    const post = surface([sym('createStream', { kind: 'value' })]);
    expect(tagsOf(pre, post)).toEqual([]);
  });

  test('入口の default が消えたときは entry-default-removed だけ（function-removed default は出さない）', () => {
    const pre = surface([sym('default', { exportStyle: 'cjs-module-default' }), sym('v1')]);
    const post = surface([sym('v1', { exportStyle: 'esm-reexport' })]);
    expect(tagsOf(pre, post)).toEqual(['entry-default-removed:default:index.js']);
  });

  test('post の入口から export を取れないときは、配られるファイルの名前ごとに比べる', () => {
    const pre = surface([sym('a'), sym('cfg', { kind: 'value', filePath: 'jest.config.js' })], { unpublishedFiles: ['jest.config.js'] });
    const post = surface([], { entryFile: undefined });
    expect(tagsOf(pre, post)).toEqual(['function-removed:a:index.js', 'module-removed:index:index.js']);
  });

  test('配られないファイルが消えても module-removed を出さない（postcss-loader の .prettierrc.js）', () => {
    const pre = surface([sym('a'), sym('singleQuote', { kind: 'value', filePath: '.prettierrc.js' }), sym('encode', { filePath: 'packets.js' })],
      { unpublishedFiles: ['.prettierrc.js'] });
    const post = surface([sym('a')]);
    expect(tagsOf(pre, post)).toEqual(['module-removed:packets:packets.js']);
  });
});

describe('computeUnpublishedFiles: npm で配られるファイル', () => {
  const run = (files: Record<string, string>, sources: string[], entry?: string) =>
    computeUnpublishedFiles(Object.keys(files), rel => files[rel], sources, entry);

  test('files の指定に無いファイルは配られない（cliui 6.0.0 の nyc.config.js）', () => {
    const files = { 'package.json': JSON.stringify({ main: 'index.js', files: ['index.js'] }), 'index.js': '', 'nyc.config.js': '' };
    expect(run(files, ['index.js', 'nyc.config.js'], 'index.js')).toEqual(['nyc.config.js']);
  });

  test('files が無ければ .npmignore で除いたもの以外は配られる', () => {
    const files = {
      'package.json': JSON.stringify({ main: 'index.js' }), '.npmignore': 'test/\n*.config.js\n!keep.config.js\n/bench',
      'index.js': '', 'packets.js': '', 'jest.config.js': '', 'keep.config.js': '', 'bench/run.js': '', 'lib/bench/x.js': '',
    };
    expect(run(files, ['index.js', 'packets.js', 'jest.config.js', 'keep.config.js', 'bench/run.js', 'lib/bench/x.js'], 'index.js'))
      .toEqual(['jest.config.js', 'bench/run.js']);
  });

  test('files が無く .npmignore も無ければすべて配られる（multicast-dns 5.5.0 の packets.js）', () => {
    const files = { 'package.json': JSON.stringify({ main: 'index.js' }), 'index.js': '', 'packets.js': '' };
    expect(run(files, ['index.js', 'packets.js'], 'index.js')).toEqual([]);
  });

  test('main がビルド結果なら、入口から相対 import で届くソースを配られるものとする（postcss-loader 4.0.4）', () => {
    const files = {
      'package.json': JSON.stringify({ main: 'dist/cjs.js', files: ['dist'] }),
      'src/index.js': "import { loadConfig } from './utils'", 'src/utils.js': '', '.prettierrc.js': '',
    };
    expect(run(files, ['src/index.js', 'src/utils.js', '.prettierrc.js'], 'src/index.js')).toEqual(['.prettierrc.js']);
  });

  test('ビルド結果がリポジトリにあっても surface のソースでなければ、入口から届くソースを配られるものとする（es6-promisify 5.0.0）', () => {
    const files = {
      'package.json': JSON.stringify({ main: 'dist/promisify.js', files: ['dist/promisify.js', 'dist/promise.js'] }),
      'dist/promisify.js': '', 'lib/promisify.js': "var Promise = require('./promise.js')", 'lib/promise.js': '', 'gulpfile.js': '',
    };
    expect(run(files, ['lib/promisify.js', 'lib/promise.js', 'gulpfile.js'], 'lib/promisify.js')).toEqual(['gulpfile.js']);
  });

  test('package.json が読めなければ決めない', () => {
    expect(run({ 'index.js': '' }, ['index.js'], 'index.js')).toBeUndefined();
  });
});

describe('resolveEntryFile: main がビルド結果なら元のソースを入口にする', () => {
  test('dist/promisify.js → lib/promisify.js', () => {
    expect(resolveEntryFile({ name: 'es6-promisify', main: 'dist/promisify.js' }, new Set(['lib/promisify.js', 'lib/promise.js']))).toBe('lib/promisify.js');
  });
  test('main がソースにあればそのまま', () => {
    expect(resolveEntryFile({ main: 'index.js' }, new Set(['index.js', 'src/index.js']))).toBe('index.js');
  });
});
