import { convertNewRequired } from '../patternGen/converters/newRequired';
import { convertExportStyleChanged } from '../patternGen/converters/exportStyleChanged';
import { convertOptionRemoved } from '../patternGen/converters/optionRemoved';
import { convertModuleFormatChanged } from '../patternGen/converters/moduleFormatChanged';
import { convertNodeNpmRequirementRaised } from '../patternGen/converters/nodeNpmRequirementRaised';
import type { ApiSymbol, LossCandidate } from '../types/LibDiff';
import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

// 生成パターン(stored 形式)を実行可能な RegExp へ（R-BC patternToScript 相当の簡易版・括弧をエスケープ）
function scriptify(storedRegex: string): string {
  const saved: string[] = [];
  let s = storedRegex.replace(/\(\?<[\w-]+>\[\\w-\]\+\)/g, (m) => {
    saved.push(m);
    return `@@${saved.length - 1}@@`;
  });
  s = s.replace(/[()]/g, (ch) => `\\${ch}`);
  return s.replace(/@@(\d+)@@/g, (_, i) => saved[Number(i)]);
}
function matchesClient(calls: ExtractFunctionCallsResult[], clientCode: string): boolean {
  const binding = clientCode.match(new RegExp(scriptify(calls[0].FunctionCallCode), 'm'));
  if (!binding) return false;
  const varName = binding.groups?.variable1;
  for (let i = 1; i < calls.length; i++) {
    let usage = calls[i].FunctionCallCode;
    if (varName) usage = usage.replace(/variable1/g, varName);
    if (!new RegExp(scriptify(usage), 'm').test(clientCode)) return false;
  }
  return true;
}
const sym = (name: string, over: Partial<ApiSymbol> = {}): ApiSymbol =>
  ({ name, kind: 'function', exportStyle: 'esm-named', filePath: 'index.js', ...over });
const cand = (over: Partial<LossCandidate> = {}): LossCandidate =>
  ({ libName: 'lib', preVersion: '1.0.0', postVersion: '2.0.0', symbol: 'func1', filePath: 'index.js',
    tag: 'return-changed', label: 'L', confidence: 'structural', ...over });
const anyMatch = (patterns: { calls: ExtractFunctionCallsResult[] }[], code: string) =>
  patterns.some(p => matchesClient(p.calls, code));

describe('new-required: 呼び出しを検出（方向は detail に保持）', () => {
  const patterns = convertNewRequired({ candidate: cand({ tag: 'new-required', symbol: 'Vinyl', detail: 'function → class' }), preSymbol: sym('Vinyl') });
  test('tag=new-required で呼び出しを検出', () => {
    expect(patterns.every(p => p.tag === 'new-required')).toBe(true);
    expect(anyMatch(patterns, "const l = require('lib');\nconst f = l.Vinyl(opts);")).toBe(true);
  });
});

describe('export-style-changed: 呼び出しを検出', () => {
  const patterns = convertExportStyleChanged({ candidate: cand({ tag: 'export-style-changed', symbol: 'v4', confidence: 'semantic', detail: 'uuid.v4 → (直接)' }), preSymbol: sym('v4') });
  test('tag/confidence を引き継ぎ呼び出しを検出', () => {
    expect(patterns.every(p => p.tag === 'export-style-changed' && p.confidence === 'semantic')).toBe(true);
    expect(anyMatch(patterns, "const l = require('lib');\nl.v4();")).toBe(true);
  });
});

describe('option-removed: 削除キーを渡す呼び出しを検出', () => {
  const input = {
    candidate: cand({ tag: 'option-removed', symbol: 'got', confidence: 'semantic', detail: '削除キー: body' }),
    preSymbol: sym('got', { optionKeys: ['json', 'body', 'form'] }),
    postSymbol: sym('got', { optionKeys: ['json', 'form'] }),
  };
  const patterns = convertOptionRemoved(input);
  // キーは regex に焼かず removedKey に持たせる（照合時に argContexts/コードのキー出現で判定＝clientDetect_match でテスト）
  test('削除キー body が removedKey に付与され、呼び出し regex 自体は got を検出する', () => {
    expect(patterns.every(p => p.importForm.endsWith('#body') && p.removedKey === 'body')).toBe(true);
    const req = patterns.find(p => p.importForm === 'cjs-require#body')!;
    // regex はキーを問わず got 呼び出しを検出（キーの有無は removedKey で照合時に判定）
    expect(matchesClient(req.calls, "const g = require('lib');\ng.got(url, { body: 'x' });")).toBe(true);
  });
  test('optionKeys が取れなくても detail からキーを拾える', () => {
    const p = convertOptionRemoved({ candidate: cand({ tag: 'option-removed', symbol: 'got', detail: '削除キー: body' }), preSymbol: sym('got') });
    expect(p.some(x => x.importForm.endsWith('#body'))).toBe(true);
  });
});

describe('module-format-changed: 方向で require/import を binding のみ検出', () => {
  test('commonjs → module: require("lib") を検出', () => {
    const p = convertModuleFormatChanged({ candidate: cand({ tag: 'module-format-changed', symbol: '(module)', detail: 'commonjs → module' }), preSymbol: sym('(module)') });
    expect(p.some(x => x.importForm === 'cjs-require')).toBe(true);
    const req = p.find(x => x.importForm === 'cjs-require')!;
    expect(req.calls.length).toBe(1);
    expect(matchesClient(req.calls, "const l = require('lib');")).toBe(true);
  });
  test('module → commonjs: esm import 側を検出（require は出さない）', () => {
    const p = convertModuleFormatChanged({ candidate: cand({ tag: 'module-format-changed', symbol: '(module)', detail: 'module → commonjs' }), preSymbol: sym('(module)') });
    expect(p.some(x => x.importForm === 'cjs-require')).toBe(false);
    expect(p.some(x => x.importForm === 'esm-default')).toBe(true);
  });
});

describe('node-npm-requirement-raised: 環境述語を生成（code-usage は出さない）', () => {
  const base = { candidate: cand({ tag: 'node-npm-requirement-raised', symbol: 'engines.node' }), preSymbol: sym('engines.node') };
  test('engines.post.node があれば env 述語（requiredMin=semver 最小）を生成・calls は空', () => {
    const p = convertNodeNpmRequirementRaised({ ...base, engines: { post: { node: '>=8' } } });
    expect(p).toHaveLength(1);
    expect(p[0].env).toEqual({ kind: 'node-engine', field: 'engines.node', requiredMin: '8.0.0' });
    expect(p[0].calls).toEqual([]);
  });
  test('engines が無ければ空配列（照合不能）', () => {
    expect(convertNodeNpmRequirementRaised(base)).toEqual([]);
  });
  test('engines.npm は対象外（空配列）', () => {
    const p = convertNodeNpmRequirementRaised({ candidate: cand({ tag: 'node-npm-requirement-raised', symbol: 'engines.npm' }), preSymbol: sym('engines.npm'), engines: { post: { npm: '>=6' } } });
    expect(p).toEqual([]);
  });
});
