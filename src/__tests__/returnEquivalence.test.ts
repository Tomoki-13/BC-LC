import { sameReturnsModuloRenaming as same } from '../libDiff/returnEquivalence';
import DiffSurface from '../libDiff/diffSurface';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

describe('sameReturnsModuloRenaming（実データの返り値）', () => {
  test('引数・ローカル名の付け替えは同じ（parse-json 2.2.0→3.0.0・indent-string 3.2.0→4.0.0）', () => {
    expect(same(['JSON.parse(x, reviver)'], ['JSON.parse(input, reviver)'])).toBe(true);
    expect(same(['str'], ['string'])).toBe(true);
  });
  test('同じパッケージ内のファイルの関数の付け替えは同じ（uuid 8.2.0→8.3.0-beta.0）', () => {
    expect(same(['buf', 'bytesToUuid(rnds)'], ['buf', 'stringify(rnds)'],
      { bytesToUuid: './bytesToUuid.js' }, { stringify: './stringify.js' })).toBe(true);
  });
  test('`a ? a : b` と `a || b` は同じ（uuid 8.0.0→8.1.0）', () => {
    expect(same(['buf ? buf : bytesToUuid(b)'], ['buf || bytesToUuid(b)'])).toBe(true);
  });
  test('空白・引用符・コメントだけの差は同じ（uuid 7.0.3→8.0.0-beta.0）', () => {
    expect(same(["crypto .createHash('md5') .update(bytes) .digest()"], ['crypto.createHash("md5").update(bytes).digest()'])).toBe(true);
    expect(same(['f(a) // x'], ['f(a)'])).toBe(true);
  });
  test('別のパッケージを指す名前は違う（globby 7.1.1→8.0.0 の glob → fastGlob）', () => {
    expect(same(['glob.sync(p)'], ['fastGlob.sync(p)'], { glob: 'glob' }, { fastGlob: 'fast-glob' })).toBe(false);
    expect(same(['union(a, b)'], ['arrayUnion(a, b)'], { union: 'array-union' }, { arrayUnion: 'array-union' })).toBe(true);
  });
  test('メソッド名・プロパティ名の変化は違う（camelcase 5.3.1→6.0.0）', () => {
    expect(same(['input.toUpperCase()'], ['input.toLocaleUpperCase()'])).toBe(false);
    expect(same(['({pkg, path: fp})'], ['({pkg, file: fp})'])).toBe(false);
  });
  test('名前の対応が1対1でなければ違う（set-value 0.2.0→0.3.0）', () => {
    expect(same(['obj || obj || obj'], ['obj || obj || res'])).toBe(false);
  });
  test('組み込みの名前・正規表現・数の変化は違う（ansi-regex 2.0.0→2.1.1）', () => {
    expect(same(['Promise.resolve(x)'], ['Bluebird.resolve(x)'])).toBe(false);
    expect(same(['/[0-9A-ORZ]/g'], ['/[0-9A-PRZ]/g'])).toBe(false);
    expect(same(['a + 1'], ['a + 2'])).toBe(false);
  });
  test('返り値が片方に無い・parse できないときは違う（lie 2.9.1→3.0.0）', () => {
    expect(same(['new Promise(resolver)'], [])).toBe(false);
    expect(same(['f(('], ['f(('])).toBe(false);
  });
});

const sym = (o: Partial<ApiSymbol>): ApiSymbol => ({
  name: 'v1', kind: 'function', exportStyle: 'cjs-property', params: ['options', 'buf', 'offset'],
  returnExprs: [], isAsync: false, optionKeys: [], filePath: 'index.js', ...o,
} as ApiSymbol);
const surface = (version: string, symbols: ApiSymbol[], importsByFile: ApiSurface['importsByFile'] = {}): ApiSurface =>
  ({ version, tag: version, scope: 'export', symbols, importsByFile });

describe('diffSurface の return-changed と export-style-changed', () => {
  test('再公開をたどった記号は定義元のファイルの読み込みで比べる（uuid 8.2.0→8.3.0-beta.0）', () => {
    const pre = surface('8.2.0', [sym({ filePath: 'src/index.js', returnExprs: ['buf', 'bytesToUuid(rnds)'], resolvedFrom: 'src/v4.js#default' })],
      { 'src/v4.js': { bytesToUuid: './bytesToUuid.js' } });
    const post = surface('8.3.0', [sym({ filePath: 'src/index.js', returnExprs: ['buf', 'stringify(rnds)'], resolvedFrom: 'src/v4.js#default' })],
      { 'src/v4.js': { stringify: './stringify.js' } });
    expect(DiffSurface.diffSurface(pre, post, 'uuid').map(c => c.tag)).toEqual([]);
  });
  test('accessPath の変数名だけの違いは export-style-changed にしない（uuid 3.0.0→3.0.1）', () => {
    const pre = surface('3.0.0', [sym({ filePath: 'uuid.js', accessPath: 'uuid.v1', exportStyle: 'unknown' })]);
    const post = surface('3.0.1', [sym({ filePath: 'uuid.js' })]);
    expect(DiffSurface.diffSurface(pre, post, 'uuid').map(c => c.tag)).toEqual([]);
  });
  test('公開名が変わったら export-style-changed（type-is 1.6.3→1.6.4 の typeofrequest.is → typeis）', () => {
    const pre = surface('1.6.3', [sym({ name: 'typeis', accessPath: 'typeofrequest.is' })]);
    const post = surface('1.6.4', [sym({ name: 'typeis' })]);
    expect(DiffSurface.diffSurface(pre, post, 'type-is').map(c => c.tag)).toEqual(['export-style-changed']);
  });
});
