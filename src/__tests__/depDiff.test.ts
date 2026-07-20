import { diffDeps } from '../depImpact/depDiff';

// 依存 range の pre→post 変化分類（added/removed/major-bump/minor-patch-bump）を検証する
const meta = (dependencies?: Record<string, string>, peerDependencies?: Record<string, string>) =>
  ({ dependencies, peerDependencies });
const byName = (changes: ReturnType<typeof diffDeps>) => Object.fromEntries(changes.map(c => [c.name, c]));

describe('diffDeps: 依存 range 変化の分類', () => {
  test('major が上がる（^4.0.2 → ^5.0.0）→ major-bump', () => {
    const c = byName(diffDeps(meta({ glob: '^4.0.2' }), meta({ glob: '^5.0.0' })));
    expect(c.glob).toMatchObject({ change: 'major-bump', preRange: '^4.0.2', postRange: '^5.0.0', kind: 'dependencies' });
  });

  test('minor/patch のみ（^4.0.2 → ^4.3.0）→ minor-patch-bump', () => {
    const c = byName(diffDeps(meta({ glob: '^4.0.2' }), meta({ glob: '^4.3.0' })));
    expect(c.glob.change).toBe('minor-patch-bump');
  });

  test('range 不変 → 変化なし', () => {
    expect(diffDeps(meta({ glob: '^4.0.2' }), meta({ glob: '^4.0.2' }))).toEqual([]);
  });

  test('依存の追加/削除', () => {
    const c = byName(diffDeps(meta({ a: '^1.0.0' }), meta({ b: '^1.0.0' })));
    expect(c.a.change).toBe('removed');
    expect(c.b.change).toBe('added');
  });

  test('peerDependencies も対象（major-bump）', () => {
    const c = byName(diffDeps(meta({}, { react: '^16.0.0' }), meta({}, { react: '^17.0.0' })));
    expect(c.react).toMatchObject({ change: 'major-bump', kind: 'peerDependencies' });
  });

  test('devDependencies は無視（対象外）', () => {
    const pre = { dependencies: {}, devDependencies: { jest: '^26' } } as any;
    const post = { dependencies: {}, devDependencies: { jest: '^29' } } as any;
    expect(diffDeps(pre, post)).toEqual([]);
  });

  test('pre/post どちらか欠落 → 空', () => {
    expect(diffDeps(undefined, meta({ a: '^1.0.0' }))).toEqual([]);
    expect(diffDeps(meta({ a: '^1.0.0' }), undefined)).toEqual([]);
  });
});
