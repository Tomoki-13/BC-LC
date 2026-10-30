import DiffSurface from '../libDiff/diffSurface';
import { convertExportsRestricted } from '../patternGen/converters/exportsRestricted';
import { typeAwarePatternMatch } from '../clientDetect/match/typeAwarePatternMatch';
import type { ApiSurface as ApiSurfaceType, LossCandidate } from '../types/LibDiff';
import type { GeneratedPattern } from '../types/patternTypes';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

const efcr = (code: string): ExtractFunctionCallsResult => ({ FunctionCallCode: code, filePath: 'client.js', line: 0, argTypes: [[]], argContexts: [[]] });
const match = (patterns: GeneratedPattern[], blocks: string[]) => typeAwarePatternMatch(patterns, [blocks.map(efcr)]).matched;
const candidate = (symbol: string, tag: LossCandidate['tag'], extra: Partial<LossCandidate> = {}): LossCandidate => ({
  libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol, filePath: 'index.js', tag, label: 'L', confidence: 'semantic', ...extra,
});

describe('exports-restricted: package.json exports の新設・縮小', () => {
  const surface = (version: string, packageExports?: ApiSurfaceType['packageExports'], moduleType: 'module' | 'commonjs' = 'commonjs'): ApiSurfaceType =>
    ({ version, tag: version, scope: 'export', symbols: [], packageExports, moduleType });

  test('exports 新設（uuid 8.0.0-beta.0 型: 本体だけ公開）→ deep import すべてが候補', () => {
    const c = DiffSurface.diffSurface(surface('7', undefined), surface('8', { subpaths: ['.'], rootRequire: true }), 'uuid');
    const ex = c.filter(x => x.tag === 'exports-restricted');
    expect(ex.map(x => x.symbol)).toEqual(['(exports)']);
    const patterns = convertExportsRestricted({ candidate: ex[0], preSymbol: { name: '(exports)', kind: 'unknown', exportStyle: 'unknown', filePath: 'package.json' } });
    expect(match(patterns, ["var v4 = require('uuid/v4')"])).toBe(true);
    expect(match(patterns, ["import v4 from 'uuid/v4'"])).toBe(true);
    expect(match(patterns, ["const { v4 } = require('uuid')"])).toBe(false);
  });

  test('公開サブパスと x/* は除く', () => {
    const cand = candidate('(exports)', 'exports-restricted', { exportsAllowed: ['.', './v4', './feature/*'] });
    const patterns = convertExportsRestricted({ candidate: cand, preSymbol: { name: '(exports)', kind: 'unknown', exportStyle: 'unknown', filePath: 'package.json' } });
    expect(match(patterns, ["require('lib/v4')"])).toBe(false);
    expect(match(patterns, ["require('lib/feature/a')"])).toBe(false);
    expect(match(patterns, ["require('lib/v4.js')"])).toBe(true);  // キーは完全一致（拡張子付きは別物）
    expect(match(patterns, ["require('lib/v1')"])).toBe(true);
  });

  test('exports からサブパスが消えた・本体の require 条件が消えた', () => {
    const c = DiffSurface.diffSurface(
      surface('1', { subpaths: ['.', './a', './b/*'], rootRequire: true }),
      surface('2', { subpaths: ['.', './a'], rootRequire: false }), 'lib');
    expect(c.filter(x => x.tag === 'exports-restricted').map(x => x.symbol).sort()).toEqual(['(require)', 'b/*']);
  });

  test('全サブパス公開（./*）の新設は候補にしない', () => {
    const c = DiffSurface.diffSurface(surface('1', undefined), surface('2', { subpaths: ['.', './*'], rootRequire: true }), 'lib');
    expect(c.some(x => x.tag === 'exports-restricted')).toBe(false);
  });
});
