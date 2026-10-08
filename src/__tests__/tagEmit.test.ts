import DiffSurface from '../libDiff/diffSurface';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

// 3つの未実装タグ（new-required / module-format-changed / module-removed）の diffSurface 検出(emit)を検証する
// 疑似ライブラリの surface を直接組んで pre/post を比較（extraction は別・ここは emit ロジックの確認）
const sym = (name: string, over: Partial<ApiSymbol> = {}): ApiSymbol =>
  ({ name, kind: 'function', exportStyle: 'esm-named', filePath: 'index.js', ...over });
const surface = (symbols: ApiSymbol[], extra: Partial<ApiSurface> = {}): ApiSurface =>
  ({ version: '1', tag: 'v1', scope: 'export', symbols, ...extra });
const tagsOf = (pre: ApiSurface, post: ApiSurface): string[] =>
  DiffSurface.diffSurface(pre, post, 'lib').map(c => c.tag);

describe('new-required: 関数↔class の変化', () => {
  // 疑似ライブラリ: pre module.exports = function Widget(){} → post class Widget {}
  test('関数 → class で new-required（new 必須化）', () => {
    const pre = surface([sym('Widget', { kind: 'function' })]);
    const post = surface([sym('Widget', { kind: 'class' })]);
    expect(tagsOf(pre, post)).toContain('new-required');
  });

  test('class → 関数 でも new-required（new 不要化）', () => {
    const pre = surface([sym('Widget', { kind: 'class' })]);
    const post = surface([sym('Widget', { kind: 'function' })]);
    expect(tagsOf(pre, post)).toContain('new-required');
  });

  test('kind 不変なら出さない', () => {
    const pre = surface([sym('Widget', { kind: 'class' })]);
    const post = surface([sym('Widget', { kind: 'class' })]);
    expect(tagsOf(pre, post)).not.toContain('new-required');
  });
});

describe('module-format-changed: CJS/ESM の変化', () => {
  // 疑似ライブラリ: pre package.json(type 無=commonjs) → post { "type": "module" }
  test('commonjs → module で emit', () => {
    const pre = surface([sym('a')], { moduleType: 'commonjs' });
    const post = surface([sym('a')], { moduleType: 'module' });
    expect(tagsOf(pre, post)).toContain('module-format-changed');
  });

  test('同じ形式なら出さない', () => {
    const pre = surface([sym('a')], { moduleType: 'commonjs' });
    const post = surface([sym('a')], { moduleType: 'commonjs' });
    expect(tagsOf(pre, post)).not.toContain('module-format-changed');
  });
});

describe('module-removed / deep-import-broken の差別化', () => {
  // ファイル削除（名前消滅）→ module-removed（サブモジュール消滅）
  test('gone.js 削除（goneFn が post に無い）→ module-removed', () => {
    const pre = surface([sym('main', { filePath: 'main.js' }), sym('goneFn', { filePath: 'gone.js' })]);
    const post = surface([sym('main', { filePath: 'main.js' })]);
    expect(tagsOf(pre, post)).toContain('module-removed');
  });

  // ファイル移動（名前生存）→ deep-import-broken（module-removed ではない）
  test('util.js → core/util.js 移動（helper 生存）→ deep-import-broken で module-removed でない', () => {
    const pre = surface([sym('helper', { filePath: 'util.js' })]);
    const post = surface([sym('helper', { filePath: 'core/util.js' })]);
    const t = tagsOf(pre, post);
    expect(t).toContain('deep-import-broken');
    expect(t).not.toContain('module-removed');
  });
});

describe('arg-removed: 中間削除=structural / 末尾削除=semantic', () => {
  const candOf = (pre: string[], post: string[]) =>
    DiffSurface.diffSurface(surface([sym('func1', { params: pre })]), surface([sym('func1', { params: post })]), 'lib')
      .find(c => c.tag === 'arg-removed');
  test('中間削除 (a,b,c)→(a,c) は structural（位置シフトで確実に破壊）', () => {
    expect(candOf(['a', 'b', 'c'], ['a', 'c'])?.confidence).toBe('structural');
  });
  test('末尾削除 (a,b,c)→(a,b) は semantic（余剰引数・c を渡す者のみ・無害あり）', () => {
    expect(candOf(['a', 'b', 'c'], ['a', 'b'])?.confidence).toBe('semantic');
  });
  test('先頭削除 (a,b,c)→(b,c) は structural（接頭辞でない＝全体シフト）', () => {
    expect(candOf(['a', 'b', 'c'], ['b', 'c'])?.confidence).toBe('structural');
  });
});
