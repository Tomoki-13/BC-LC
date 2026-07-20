import DiffSurface from '../libDiff/diffSurface';
import type { ApiSurface } from '../types/LibDiff';

// engines(node/npm) の下限引き上げ検出（package.json 由来のランタイム要求変化）を検証する
const surface = (version: string, engines?: { node?: string; npm?: string }): ApiSurface =>
  ({ version, tag: `v${version}`, scope: 'export', symbols: [], engines });

const enginesCauses = (pre: ApiSurface, post: ApiSurface): string[] =>
  DiffSurface.diffSurface(pre, post, 'lib').filter(c => c.tag === 'node-npm-requirement-raised').map(c => c.detail ?? '');

describe('diffSurface: engines 下限引き上げ', () => {
  test('node の下限が上がる（>=12 → >=14）→ node-npm-requirement-raised', () => {
    const causes = enginesCauses(surface('1.0.0', { node: '>=12' }), surface('2.0.0', { node: '>=14' }));
    expect(causes.length).toBe(1);
    expect(causes[0]).toContain('engines.node');
    expect(causes[0]).toContain('12.0.0 → 14.0.0');
  });

  test('新規に下限が付く（なし → >=16）→ node-npm-requirement-raised', () => {
    const causes = enginesCauses(surface('1.0.0'), surface('2.0.0', { node: '>=16' }));
    expect(causes.length).toBe(1);
    expect(causes[0]).toContain('新規に 16.0.0 以上');
  });

  test('下限が下がる（>=14 → >=12）→ 損失なし', () => {
    expect(enginesCauses(surface('1.0.0', { node: '>=14' }), surface('2.0.0', { node: '>=12' }))).toEqual([]);
  });

  test('変化なし（>=14 → >=14）→ 損失なし', () => {
    expect(enginesCauses(surface('1.0.0', { node: '>=14' }), surface('2.0.0', { node: '>=14' }))).toEqual([]);
  });

  test('制約が消える（>=14 → なし）→ 損失なし（緩和）', () => {
    expect(enginesCauses(surface('1.0.0', { node: '>=14' }), surface('2.0.0'))).toEqual([]);
  });

  test('実質無制限の新規付与（なし → *）→ 損失なし', () => {
    expect(enginesCauses(surface('1.0.0'), surface('2.0.0', { node: '*' }))).toEqual([]);
  });

  test('node と npm の両方が上がる → 2件', () => {
    const causes = enginesCauses(
      surface('1.0.0', { node: '>=12', npm: '>=6' }),
      surface('2.0.0', { node: '>=14', npm: '>=8' }),
    );
    expect(causes.length).toBe(2);
    expect(causes.some(d => d.includes('engines.node'))).toBe(true);
    expect(causes.some(d => d.includes('engines.npm'))).toBe(true);
  });
});
