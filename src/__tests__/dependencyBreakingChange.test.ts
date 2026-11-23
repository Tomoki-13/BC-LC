import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import apiSurface from '../libDiff/apiSurface';
import { findDependencyBreakingChanges, findDependencyVersion, rangesOverlap } from '../dependencyLoss/dependencyBreakingChange';
import { repositoryUrlOf, repoDirName } from '../setup/cloneDependencies';
import { buildLibraryFunctionGraph, findCallersReaching } from '../dependencyLoss/libraryFunctionGraph';
import type { DepChange } from '../utils/evalShared';

const write = (dir: string, files: Record<string, string>) => {
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
};
const git = (dir: string, cmd: string) => execSync(`git -C "${dir}" ${cmd}`, { stdio: 'ignore' });

/** 依存パッケージ dep-x のクローン（v1.0.0：引数 2 つ → v2.0.0：引数 1 つ）を cloneBase/dep-x/owner__dep-x に作る */
function makeDependencyClone(cloneBase: string): void {
  const repo = path.join(cloneBase, 'dep-x', 'owner__dep-x');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init -q');
  git(repo, 'config user.email t@example.com');
  git(repo, 'config user.name t');
  write(repo, { 'package.json': JSON.stringify({ name: 'dep-x', version: '1.0.0', main: 'index.js' }), 'index.js': 'module.exports = function add(a, b) { return a + b; };\n' });
  git(repo, 'add -A');
  git(repo, 'commit -qm v1');
  git(repo, 'tag v1.0.0');
  write(repo, { 'package.json': JSON.stringify({ name: 'dep-x', version: '2.0.0', main: 'index.js' }), 'index.js': 'module.exports = function add(a) { return a; };\n' });
  git(repo, 'add -A');
  git(repo, 'commit -qm v2');
  git(repo, 'tag v2.0.0');
}

describe('依存パッケージの破壊的変更が及ぶ公開関数', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclc-dependency-'));
  const cloneBase = path.join(root, 'clones');
  const lib = path.join(root, 'lib');
  makeDependencyClone(cloneBase);
  write(lib, {
    'package.json': JSON.stringify({ name: 'lib', version: '2.0.0', main: 'index.js', dependencies: { 'dep-x': '^2.0.0' } }),
    'index.js': [
      "const add = require('dep-x');",
      'function helper(x) { return add(x, 1); }',
      'module.exports = function main(y) { return helper(y); };',
      'module.exports.other = function other() { return 0; };',
      '',
    ].join('\n'),
  });
  const change: DepChange = { name: 'dep-x', kind: 'dependencies', preRange: '^1.0.0', postRange: '^2.0.0', change: 'major-bump' };
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test('依存パッケージの引数の削除 → それを呼ぶ helper → 公開関数 main（default）が候補になる', async () => {
    const post = await apiSurface.buildApiSurface(lib, '2.0.0', 'v2.0.0');
    const { candidates, checks } = await findDependencyBreakingChanges('lib', '1.0.0', '2.0.0', post, () => lib, [change], cloneBase);
    expect(checks[0]).toMatchObject({ dependency: 'dep-x', fromVersion: '1.0.0', toVersion: '2.0.0', status: 'hit' });
    // 依存パッケージの損失（引数の削除・返り値の変化）ごとに 1 件
    expect([...new Set(candidates.map(c => c.symbol))]).toEqual(['default']);
    expect(candidates.every(c => c.tag === 'dependency-breaking-change' && c.filePath === 'index.js')).toBe(true);
    const arg = candidates.find(c => c.detail!.includes('arg-removed:default'))!;
    expect(arg.detail).toContain('dep-x@1.0.0..2.0.0 arg-removed:default');
    expect(arg.detail).toContain('index.js#helper → index.js#default（1 段）');
  });

  test('前後の範囲が重なる依存パッケージは調べない（range_overlap）', async () => {
    const post = await apiSurface.buildApiSurface(lib, '2.0.0', 'v2.0.0');
    const { candidates, checks } = await findDependencyBreakingChanges('lib', '1.0.0', '2.0.0', post, () => lib,
      [{ ...change, preRange: '^1.0.0', postRange: '^1.2.0', change: 'minor-patch-bump' }], cloneBase);
    expect(candidates).toEqual([]);
    expect(checks[0]).toMatchObject({ status: 'range_overlap', fromVersion: '1.0.0', toVersion: '1.2.0' });
    expect(rangesOverlap('~1.2.0', '~1.3.0')).toBe(false);
    expect(rangesOverlap('0.4.0', '0.5.0')).toBe(false);
    expect(rangesOverlap('^0.0.7', '0.0.8')).toBe(false);
    expect(rangesOverlap('^5.2.6', '^5.2.9')).toBe(true);
  });

  test('クローンが無い依存パッケージは no_source', async () => {
    const post = await apiSurface.buildApiSurface(lib, '2.0.0', 'v2.0.0');
    const { candidates, checks } = await findDependencyBreakingChanges('lib', '1.0.0', '2.0.0', post, () => lib,
      [{ ...change, name: 'not-cloned' }], cloneBase);
    expect(candidates).toEqual([]);
    expect(checks[0].status).toBe('no_source');
  });
});

describe('呼び出し元をたどる', () => {
  test('循環していても止まり，段数の上限を超えない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclc-graph-'));
    write(dir, { 'a.js': 'function a() { b(); }\nfunction b() { a(); }\nfunction c() { a(); }\n' });
    const graph = await buildLibraryFunctionGraph(dir);
    const start = graph.functions.find(f => f.name === 'a')!;
    const found = findCallersReaching(graph, start, fn => fn.name === 'c');
    expect(found.map(f => f.path.map(p => p.name))).toEqual([['a', 'c']]);
    expect(findCallersReaching(graph, start, fn => fn.name === 'c', 0)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('依存パッケージのクローンとバージョン', () => {
  test('repository の省略形（owner/repo・github:owner/repo）を GitHub の URL にする', () => {
    expect(repositoryUrlOf({ repository: 'floatdrop/pinkie' })).toBe('https://github.com/floatdrop/pinkie');
    expect(repositoryUrlOf({ repository: { url: 'github:helmetjs/csp' } })).toBe('https://github.com/helmetjs/csp');
    expect(repositoryUrlOf({ repository: { url: 'git://github.com/helmetjs/frameguard.git' } })).toBe('https://github.com/helmetjs/frameguard');
  });
  test('clone の置き場は <owner>__<repo>', () => {
    expect(repoDirName('https://github.com/helmetjs/frameguard')).toBe('helmetjs__frameguard');
  });
  test('タグはあっても package.json の name が違うリポジトリ（monorepo の root など）は使わない', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclc-mismatch-'));
    const repo = path.join(root, 'helmetjs__helmet');
    fs.mkdirSync(repo);
    git(repo, 'init -q');
    git(repo, 'config user.email t@example.com');
    git(repo, 'config user.name t');
    write(repo, { 'package.json': JSON.stringify({ name: 'helmet', version: '3.0.0' }), 'index.js': 'module.exports = 1;\n' });
    git(repo, 'add -A');
    git(repo, 'commit -qm v3');
    git(repo, 'tag v3.0.0');
    expect(findDependencyVersion([repo], 'frameguard', '3.0.0')).toBe('repository_mismatch');
    expect(findDependencyVersion([repo], 'helmet', '3.0.0')).toMatchObject({ repoDir: repo, ref: 'v3.0.0' });
    expect(findDependencyVersion([repo], 'helmet', '9.9.9')).toBe('ref_unresolved');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
