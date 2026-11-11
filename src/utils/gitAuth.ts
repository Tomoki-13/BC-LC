/**
 * GITHUB_TOKEN を git に渡すための環境変数（git clone / fetch の execSync・exec に env として渡す）
 *   http.https://github.com/.extraheader を GIT_CONFIG_COUNT/KEY/VALUE（git 2.31 以降）で与える。
 *   トークンは clone の URL・各クローンの .git/config・コマンドの引数のどれにも残らない。
 *   トークンが無ければ認証なし（公開リポジトリだけ取れる）。
 */
export function githubAuthEnv(token: string | undefined = process.env.GITHUB_TOKEN): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** owner/repo（または https://github.com/owner/repo）の、トークンを含まない clone の URL */
export function githubCloneUrl(repo: string): string {
  const base = repo.startsWith('https://') ? repo : `https://github.com/${repo}`;
  return base.endsWith('.git') ? base : `${base}.git`;
}
