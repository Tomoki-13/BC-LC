import { listPublicApis, readDtsDeclarations, checkAgainstDts, firstLevelApis, apisFromDiagnoseGraph } from '../evaluation/publicApiInventory';
import type { ApiSurface, ApiSymbol } from '../types/LibDiff';

const sym = (o: Partial<ApiSymbol>): ApiSymbol => ({
  name: 'v1', kind: 'function', exportStyle: 'cjs-property', params: [], returnExprs: [], isAsync: false, optionKeys: [], filePath: 'index.js', ...o,
} as ApiSymbol);
const surface: ApiSurface = {
  version: '3.4.0', tag: 'v3.4.0', scope: 'export', entryFile: 'index.js',
  symbols: [
    sym({ name: 'default', params: ['options', 'buf', 'offset'], resolvedFrom: 'v4.js#default', exportStyle: 'cjs-module-default' }),
    sym({ name: 'v1', params: ['options', 'buf', 'offset'], resolvedFrom: 'v1.js#default' }),
    sym({ name: 'v4', accessPath: 'uuid.v4', params: ['options', 'buf', 'offset'] }),
    sym({ name: 'default', filePath: 'v1.js', params: ['options', 'buf', 'offset'], exportStyle: 'cjs-module-default' }),
    sym({ name: 'VERSION', kind: 'value', exportStyle: 'esm-named' }),
  ],
};

describe('listPublicApis', () => {
  test('入口は <lib>・<lib>.name、他のファイルは <lib/sub>（DIAGNOSE の表記）', () => {
    const apis = listPublicApis('uuid', surface);
    expect(apis.map(a => [a.api, a.fromEntry])).toEqual([
      ['<uuid>', true], ['<uuid>.v1', true], ['<uuid>.v4', true], ['<uuid/v1>', false], ['<uuid>.VERSION', true],
    ]);
  });
});

describe('readDtsDeclarations と checkAgainstDts', () => {
  const dts = `
    declare function uuid(options?: Options, buf?: number[], offset?: number): string;
    declare namespace uuid {
      function v1(options?: Options, buf?: number[], offset?: number): string;
      function v4(options?: Options): string;
      const VERSION: string;
    }
    interface Options { random?: number[] }
    export = uuid;`;
  test('export = X は X を default、namespace のメンバを名前つき export として読む', () => {
    const d = readDtsDeclarations('index.d.ts', dts);
    expect([...d.keys()].sort()).toEqual(['VERSION', 'default', 'v1', 'v4']);
    expect(d.get('v4')).toEqual({ name: 'v4', kind: 'function', arities: [{ min: 0, max: 1 }], returnsPromise: false });
    expect(d.get('VERSION')?.kind).toBe('value');
  });
  test('引数の個数・種類・Promise を比べる', () => {
    const rows = checkAgainstDts('uuid', '3.4.0', listPublicApis('uuid', surface), readDtsDeclarations('index.d.ts', dts));
    const by = new Map(rows.map(r => [r.api, r]));
    expect(by.get('<uuid>.v1')?.arityResult).toBe('same');
    expect(by.get('<uuid>.v4')?.arityResult).toBe('surface-more'); // surface は 3 個、.d.ts は 0〜1 個
    expect(by.get('<uuid>.VERSION')?.kindResult).toBe('value-in-surface');
  });
  test('ESM の export function・Promise を返す宣言・型だけの export', () => {
    const d = readDtsDeclarations('index.d.ts', `
      export function sync(patterns: string | string[], ...rest: any[]): string[];
      export default function globby(patterns: string, options?: object): Promise<string[]>;
      export interface Options { cwd?: string }
      export type Pattern = string;`);
    expect([...d.keys()].sort()).toEqual(['default', 'sync']);
    expect(d.get('sync')?.arities).toEqual([{ min: 1, max: Infinity }]);
    expect(d.get('default')?.returnsPromise).toBe(true);
  });
});

describe('DIAGNOSE の表記', () => {
  test('related_apis の { } を1段目の API 名に広げる', () => {
    expect(firstLevelApis('<uuid>.{parse,unparse}')).toEqual(['<uuid>.parse', '<uuid>.unparse']);
    expect(firstLevelApis('<async>.{queue,cargo}().drain')).toEqual(['<async>.queue', '<async>.cargo']);
    expect(firstLevelApis('<lib/sub>')).toEqual(['<lib/sub>']);
  });
  test('グラフの開始ノードから ownProp をたどる', () => {
    const graph = { nodes: [
      { id: 0, type: 'start', edges: [{ type: 'ownProp', name: 'v1', target: { nodeId: 1 } }, { type: 'call', target: { nodeId: 2 } }] },
      { id: 1, type: 'object', edges: [{ type: 'ownProp', name: 'length', target: { nodeId: 2 } }] },
      { id: 2, type: 'object', edges: [] },
    ] };
    expect(apisFromDiagnoseGraph('uuid', graph)).toEqual(['<uuid>', '<uuid>.v1']);
    expect(apisFromDiagnoseGraph('uuid', graph, 2)).toEqual(['<uuid>', '<uuid>.v1', '<uuid>.v1.length']);
  });
});
