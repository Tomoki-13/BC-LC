import { compareDtsWithSurface, parseDtsExports } from '../libDiff/dtsValidation';
import type { ApiSymbol } from '../types/LibDiff';

const sym = (name: string, exportStyle = 'cjs-property'): ApiSymbol =>
  ({ name, kind: 'function', exportStyle, params: [], returnExprs: [], isAsync: false, optionKeys: [], filePath: 'index.js' } as unknown as ApiSymbol);
const values = (content: string) => [...parseDtsExports('index.d.ts', content).value].sort();

describe('.d.ts の値 export の抽出', () => {
  test('export = 関数 → default（モジュール本体）', () => {
    expect(values('declare function ansiRegex(): RegExp;\nexport = ansiRegex;')).toEqual(['default']);
  });

  test('export = 関数 ＋ namespace の値メンバ（型は除く）', () => {
    const dts = `declare function flatten(a: any[]): any[];
declare namespace flatten {
  export interface NestedArray {}
  export function from(a: any): any[];
  export function depth(a: any, d: number): any[];
}
export = flatten;`;
    expect(values(dts)).toEqual(['default', 'depth', 'from']);
  });

  test('export = const（呼び出しシグネチャ付きの型リテラル）→ default ＋ メンバ', () => {
    const dts = `declare const globby: {
  (patterns: string): Promise<string[]>;
  sync(patterns: string): string[];
  readonly hasMagic: boolean;
};
export = globby;`;
    expect(values(dts)).toEqual(['default', 'hasMagic', 'sync']);
  });

  test('export = const（呼び出せない object）→ メンバだけ（default は数えない）', () => {
    expect(values('declare const internalIp: { v6(): string; v4(): string };\nexport = internalIp;')).toEqual(['v4', 'v6']);
  });

  test('export = const（interface 型）→ interface のメンバ', () => {
    const dts = `interface Dirs { readonly data?: string; config(): string; }
declare const xdg: Dirs;
export = xdg;`;
    expect(values(dts)).toEqual(['config', 'data']);
  });

  test('ESM の export default / named export', () => {
    expect(values('export default function f(): void;\nexport declare const a: number;\nexport interface T {}')).toEqual(['a', 'default']);
  });
});

describe('surface との突き合わせ', () => {
  test('default は surface の default export（cjs-module-default）と対応する', () => {
    const r = compareDtsWithSurface('index.d.ts', 'declare function f(): void;\nexport = f;', [sym('default', 'cjs-module-default')]);
    expect(r).toMatchObject({ dtsExportCount: 1, matchedCount: 1, coverage: 1, missing: [] });
  });

  test('surface に無いメンバは missing に出る', () => {
    const dts = 'declare const c: { (a: string): number; compare(a: string): boolean };\nexport = c;';
    const r = compareDtsWithSurface('index.d.ts', dts, [sym('default', 'cjs-module-default')]);
    expect(r).toMatchObject({ dtsExportCount: 2, matchedCount: 1, coverage: 0.5, missing: ['compare'] });
  });

  test('値 export が0件なら coverage を付けない', () => {
    const r = compareDtsWithSurface('index.d.ts', 'export interface Options {}', []);
    expect(r.coverage).toBeUndefined();
    expect(r).toMatchObject({ hasDts: true, dtsExportCount: 0, typeExportCount: 1 });
  });
});

describe('.d.ts の書き方の揺れ', () => {
  test("declare module 'lib' { … export = X } の中身を読む", () => {
    const dts = `declare module 'fast-deep-equal' {
    const equal: (a: any, b: any) => boolean;
    export = equal;
}`;
    expect(values(dts)).toEqual(['default']);
  });

  test('declare module の中の namespace の値メンバ', () => {
    const dts = `declare module "ipaddr.js" {
  namespace Address {
    export function parse(addr: string): any;
    export class IPv4 {}
    export interface RangeList {}
  }
  export = Address;
}`;
    expect(values(dts)).toEqual(['IPv4', 'parse']); // namespace だけ＝呼べない object
  });

  test('A & B の型（呼べない object）→ 読める部分のメンバだけ', () => {
    const dts = `declare namespace s { interface Modifier { bold: string } }
declare const s: { readonly modifier: s.Modifier; readonly codes: Map<number, number> } & s.Modifier;
export = s;`;
    expect(values(dts)).toEqual(['codes', 'modifier']);
  });
});
