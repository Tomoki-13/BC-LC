import fs from 'fs';
import os from 'os';
import pathmod from 'path';
import { dependencyPath } from '../clientDetect/match/dependencyMatch';

const makeRepo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'dep-'));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(pathmod.join(dir, rel), body);
  return dir;
};

describe('dependencyPath: 直接 import の無いクライアントが依存を辿って lib に届くか（registry は使わない）', () => {
  beforeAll(() => { process.env.BCLC_DEP_REGISTRY = '0'; });
  afterAll(() => { delete process.env.BCLC_DEP_REGISTRY; });

  test('package.json の依存に記載（設定ファイル・CLI 経由の利用）', async () => {
    const repo = makeRepo({ 'package.json': JSON.stringify({ devDependencies: { 'eslint-config-prettier': '^3.0.0' } }) });
    expect(await dependencyPath(repo, 'eslint-config-prettier')).toBe('package.json:devDependencies');
  });

  test('yarn.lock に記載（間接依存）', async () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ dependencies: { del: '^3.0.0' } }),
      'yarn.lock': 'del@^3.0.0:\n  dependencies:\n    globby "^6.1.0"\n\nglobby@^6.1.0:\n  version "6.1.0"\n',
    });
    expect(await dependencyPath(repo, 'globby')).toBe('lockfile:yarn.lock');
  });

  test('名前が前方一致するだけの別パッケージ（globby-x）は届かない', async () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ dependencies: { a: '1' } }),
      'yarn.lock': 'globby-x@^1.0.0:\n  version "1.0.0"\n',
    });
    expect(await dependencyPath(repo, 'globby')).toBeNull();
  });
});
