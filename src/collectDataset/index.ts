// ==========================================
// collectDataset — エントリーポイント
// ------------------------------------------
// 特定ライブラリの更新後バージョン(target)に対し、
//   1. npm registry から「一つ前(pre)」のバージョンを解決
//   2. その pre を使う（= まだ post に移行していない）クライアントを
//      「一定の開発実績・品質」条件付きで収集（既存データがあれば加算して規定数に到達）
//   3. 採用クライアントを clone（codesearch_clientRepos）
//   4. ライブラリ本体の pre/post を clone して変更差分(diff)を取得
// を実行しデータセットとして保存
//
// 後続（予定）: 取得した diff を静的解析し「変更された関数」を特定
//
// 実行: cd BC-LC/src && npx tsx collectDataset/index.ts [lib] [targetVersion] [count]
//   引数省略時は下記 DEFAULT_CONFIG を使用
//
// 必要な環境変数: GITHUB_TOKEN（code search / contents API / clone 用）
// ==========================================

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

import output_json from '../utils/output_json';
import type { CollectConfig, ClientHit } from './types';
import {
  fetchVersionList,
  fetchVersionMeta,
  resolvePreviousVersion,
  extractRepositoryUrl,
} from './npm/registry';
import { searchRepositories } from './github/searchRepositories';
import { DEFAULT_QUALITY, type QualityCriteria } from './github/repoQuality';
import { cloneLibVersions } from './lib/cloneLibVersions';
import { cloneClient } from './lib/cloneClients';
import { getToken } from './github/githubClient';

// .env を複数候補から読み込む（実行 cwd=BC-LC/src を基準に BC-LC ルート / メタルート）
// shell で export 済みの値が最優先（dotenv は既存の env を上書きしない）
for (const envPath of ['.env', '../.env', '../../.env']) {
  dotenv.config({ path: path.resolve(process.cwd(), envPath) });
}

// ==========================================
// 設定（引数が無ければこの既定値を使用）
// ==========================================
const DEFAULT_CONFIG: CollectConfig = {
  libraryName: 'next',
  targetVersion: '2.0.0',
  numberOfRepos: 5,
  includePrerelease: false,
};

/** クライアント品質条件（README に明記） */
const QUALITY: QualityCriteria = DEFAULT_QUALITY;

/** 採用クライアントを clone するか */
const CLONE_CLIENTS = true;

// 入出力パス（process.cwd() = BC-LC/src を基準に、親のメタリポ配下を参照）
const PATHS = {
  /** 収集結果(client_list / versions / diff) の保存先 */
  outBase: '../../outputs/latest/BC-LC/collectDataset',
  /** ライブラリ本体 pre/post の clone 先 */
  libCloneBase: '../../clonedata/lib_versions',
  /** クライアントの clone 先 */
  clientCloneBase: '../../clonedata/codesearch_clientRepos',
};

function parseArgs(): CollectConfig {
  const [lib, target, count] = process.argv.slice(2);
  return {
    libraryName: lib || DEFAULT_CONFIG.libraryName,
    targetVersion: target || DEFAULT_CONFIG.targetVersion,
    numberOfRepos: count ? Number(count) : DEFAULT_CONFIG.numberOfRepos,
    includePrerelease: DEFAULT_CONFIG.includePrerelease,
  };
}

/** 既存の client_list.json を読み込む（無ければ空 / 重複除去） */
function loadExistingClients(outDir: string): ClientHit[] {
  const p = path.join(outDir, 'client_list.json');
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf-8')) as ClientHit[];
    const seen = new Set<string>();
    const out: ClientHit[] = [];
    for (const c of arr) {
      if (c?.fullName && !seen.has(c.fullName)) {
        seen.add(c.fullName);
        out.push(c);
      }
    }
    return out;
  } catch {
    console.error(`  [Warn] 既存 client_list.json の解析に失敗。無視します: ${p}`);
    return [];
  }
}

async function main(): Promise<void> {
  const config = parseArgs();
  const token = getToken();

  console.log('==================================================');
  console.log(`[collectDataset] ${config.libraryName}@${config.targetVersion}  (clients=${config.numberOfRepos})`);
  console.log(
    `[Quality] ★>=${QUALITY.minStars}, 更新<=${QUALITY.maxInactiveDays}日, ` +
      `fork除外=${QUALITY.excludeForks}, archived除外=${QUALITY.excludeArchived}`
  );
  console.log('==================================================');

  // --- 1. バージョン解決（npm registry） ---
  const versionList = await fetchVersionList(config.libraryName);
  const resolved = resolvePreviousVersion(
    config.libraryName,
    versionList,
    config.targetVersion,
    config.includePrerelease
  );
  console.log(`[Versions] pre=${resolved.preVersion}  post=${resolved.postVersion}`);

  // 出力ディレクトリ: outputs/latest/BC-LC/collectDataset/<lib>@<post>/
  const safeName = config.libraryName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const outDir = path.resolve(process.cwd(), PATHS.outBase, `${safeName}@${resolved.postVersion}`);
  output_json.createOutputDirectory(outDir);
  fs.writeFileSync(path.join(outDir, 'resolved_versions.json'), JSON.stringify(resolved, null, 2));

  // --- 2. クライアント収集（既存分を加算して規定数に到達させる） ---
  const existing = loadExistingClients(outDir);
  if (existing.length > 0) {
    console.log(`[Resume] 既存 ${existing.length} 件を確認（規定数 ${config.numberOfRepos} の一部として加算）`);
  }
  const needed = Math.max(0, config.numberOfRepos - existing.length);
  const fresh =
    needed > 0
      ? await searchRepositories({
          libraryName: config.libraryName,
          preVersion: resolved.preVersion,
          postVersion: resolved.postVersion,
          needed,
          exclude: new Set(existing.map((c) => c.fullName)),
          quality: QUALITY,
          token,
        })
      : [];
  const clients = [...existing, ...fresh];
  console.log(`[Clients] 既存 ${existing.length} + 新規 ${fresh.length} = ${clients.length} 件`);

  fs.writeFileSync(path.join(outDir, 'client_list.json'), JSON.stringify(clients, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'client_names.json'),
    JSON.stringify(clients.map((c) => c.fullName), null, 2)
  );

  // --- 3. 採用クライアントの clone（既存で中身があるものはスキップ） ---
  if (CLONE_CLIENTS && clients.length > 0) {
    const clientCloneDir = path.join(PATHS.clientCloneBase, safeName);
    const results = [];
    for (const c of clients) {
      const r = await cloneClient(c.fullName, clientCloneDir, token);
      results.push(r);
      console.log(`  [Client ${r.status}] ${c.fullName}`);
    }
    fs.writeFileSync(path.join(outDir, 'clone_clients_result.json'), JSON.stringify(results, null, 2));
  }

  // --- 4. ライブラリ本体 pre/post の取得＋差分 ---
  let diffResult = null;
  const postMeta = await fetchVersionMeta(config.libraryName, resolved.postVersion);
  const repoUrl = extractRepositoryUrl(postMeta);
  if (!repoUrl) {
    console.error('[Warn] ライブラリの git リポジトリ URL を特定できず、diff 取得をスキップします。');
  } else {
    diffResult = await cloneLibVersions(
      repoUrl,
      config.libraryName,
      resolved.preVersion,
      resolved.postVersion,
      PATHS.libCloneBase,
      outDir,
      token
    );
    if (diffResult) {
      fs.writeFileSync(path.join(outDir, 'lib_diff.json'), JSON.stringify(diffResult, null, 2));
    }
  }

  // --- サマリ ---
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        libraryName: config.libraryName,
        preVersion: resolved.preVersion,
        postVersion: resolved.postVersion,
        clientsCollected: clients.length,
        clientsRequested: config.numberOfRepos,
        clientsExisting: existing.length,
        clientsNew: fresh.length,
        quality: QUALITY,
        changedFiles: diffResult?.changedFiles.length ?? null,
        repoUrl: repoUrl ?? null,
        generatedAt: output_json.formatDateTime(new Date()),
      },
      null,
      2
    )
  );

  console.log(`\n[Done] 出力: ${outDir}`);
}

main().catch((e) => {
  console.error('[Fatal]', e);
  process.exit(1);
});
