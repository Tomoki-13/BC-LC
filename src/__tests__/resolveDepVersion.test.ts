import { resolveVersionAsOf, TimeMap } from '../depImpact/resolveDepVersion';

// asOf 時点の release-date max-satisfying による依存解決版の算出を検証する
const versions = ['1.0.0', '1.1.0', '2.0.0', '2.1.0', '2.4.0', '3.0.0'];
const time: TimeMap = {
  created: '2019-01-01T00:00:00.000Z',
  '1.0.0': '2020-01-01T00:00:00.000Z',
  '1.1.0': '2020-06-01T00:00:00.000Z',
  '2.0.0': '2021-01-01T00:00:00.000Z',
  '2.1.0': '2021-06-01T00:00:00.000Z',
  '2.4.0': '2022-06-01T00:00:00.000Z',
  '3.0.0': '2023-01-01T00:00:00.000Z',
  modified: '2023-02-01T00:00:00.000Z',
};

describe('resolveVersionAsOf: 依存 range の解決版', () => {
  test('range 不変でも asOf が動けば解決版は浮動する（^2.0.0 が 2.1.0 → 2.4.0）', () => {
    expect(resolveVersionAsOf(versions, time, '^2.0.0', new Date('2021-07-01'))).toBe('2.1.0');
    expect(resolveVersionAsOf(versions, time, '^2.0.0', new Date('2022-07-01'))).toBe('2.4.0');
  });

  test('asOf 時点で未公開の未来版は候補に入らない（^3.0.0 は 2022 時点で解決不能）', () => {
    expect(resolveVersionAsOf(versions, time, '^3.0.0', new Date('2022-07-01'))).toBeNull();
    expect(resolveVersionAsOf(versions, time, '^3.0.0', new Date('2023-02-01'))).toBe('3.0.0');
  });

  test('caret は major を跨がない（^1.0.0 は 1.x の最大）', () => {
    expect(resolveVersionAsOf(versions, time, '^1.0.0', new Date('2023-02-01'))).toBe('1.1.0');
  });

  test('固定版はその版に解決（=2.0.0）', () => {
    expect(resolveVersionAsOf(versions, time, '2.0.0', new Date('2023-02-01'))).toBe('2.0.0');
  });

  test('semver でない range は解決不能（github:/file:）', () => {
    expect(resolveVersionAsOf(versions, time, 'github:foo/bar#branch', new Date('2023-02-01'))).toBeNull();
    expect(resolveVersionAsOf(versions, time, 'file:../local', new Date('2023-02-01'))).toBeNull();
  });

  test('asOf 未指定なら全版から解決（時系列フィルタなし）', () => {
    expect(resolveVersionAsOf(versions, time, '*', undefined)).toBe('3.0.0');
  });

  test('created/modified は版として扱わない', () => {
    expect(resolveVersionAsOf(versions, time, '*', new Date('2023-02-01'))).toBe('3.0.0');
  });
});
