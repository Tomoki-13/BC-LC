// クライアント repo の package.json の scripts.test を種別に分類する。
//   standard      … lint 系のみ（standard/eslint を含み && なし）＝ライブラリを実行しないテスト
//   no test       … 既定プレースホルダ（"no test specified" 等）
//   no scripts    … scripts.test が無い
//   noPackage.json… package.json が無い/壊れている
//   client        … 実際のクライアントテスト（上記以外）＝破壊を実際に踏みうる
// package.json は client repo 直下のみ見る（親を遡って無関係な package.json を拾わないため）。

import fs from 'fs';
import path from 'path';

export type TestScriptStatus = 'standard' | 'no test' | 'no scripts' | 'noPackage.json' | 'client';

export function classifyTestScript(repoDir: string): TestScriptStatus {
  const pkgPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'noPackage.json';

  let pkg: any;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return 'noPackage.json'; }

  const testScript: string | undefined = pkg.scripts?.test;
  if (!testScript) return 'no scripts';

  const script = testScript.toLowerCase();
  if (!script.includes('&&') && (script.includes('standard') || script.includes('eslint'))) return 'standard';
  if (script.includes('no test')) return 'no test';
  return 'client';
}
