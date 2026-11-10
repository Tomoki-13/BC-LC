import { execSync } from 'child_process';
import { githubAuthEnv, githubCloneUrl } from '../utils/gitAuth';

describe('githubAuthEnv: トークンを環境変数だけで git に渡す', () => {
  test('トークンがあると、git が github.com 向けの認証ヘッダを読む', () => {
    const env = githubAuthEnv('dummy-token');
    const header = execSync('git config --get http.https://github.com/.extraheader', { env }).toString().trim();
    expect(header).toBe(`AUTHORIZATION: basic ${Buffer.from('x-access-token:dummy-token').toString('base64')}`);
  });
  test('トークンが無いと、認証の設定を足さない', () => {
    const env = githubAuthEnv('');
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('githubCloneUrl: トークンを含まない URL', () => {
  test.each([
    ['owner/repo', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
  ])('%s → %s', (input, expected) => {
    expect(githubCloneUrl(input)).toBe(expected);
  });
});
