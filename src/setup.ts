import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import { runBuildTargets } from './setup/buildTargets';
import { runPrepareClients } from './setup/prepareClients';
import { runCloneClients } from './setup/cloneClients';
import { TEST_RESULT_PATH } from './utils/evalShared';
import { initRunLog, phase, logEvent } from './utils/runLog';

// 本実行の前に一度だけ走らせる前処理エントリ
//   ここで全ての前処理を終わらせてから make run / make client-detect に進む。
//   前処理: (1) パターン生成の版ペア targets.all.json を生成 → (2) 検出入力 client_detect_clients.json を生成 → (3) クライアントを clonedata に clone し、テストしたときのコミットにそろえる。
//   実行: cd src && npx tsx setup.ts  （make setup）

const PROPOSAL_PATH = '../../datasets/proposal_result.json';

function requireFile(rel: string, hint: string): void {
  const abs = path.resolve(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    console.error(`[setup] 必要なデータがありません: ${abs}\n        ${hint}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  initRunLog('setup');
  console.log('[setup] 前処理を開始');

  // 0) 依存データセットの存在チェック（無いと以降が失敗するので先に明示）
  requireFile(TEST_RESULT_PATH, 'クライアント単位の正解（採点 GT）。datasets に配置してください');
  requireFile(PROPOSAL_PATH, 'ライブラリ版遷移（版ペアの供給元）。datasets に配置してください');

  // 1) パターン生成の版ペア入力（記録 prev/updated ペア）を生成
  console.log('[setup] (1/3) パターン生成の版ペア targets.all.json を生成');
  phase('build-targets');
  await runBuildTargets();

  // 2) client-detect の検出入力（依存メンバーシップ・結果なし）を生成
  console.log('[setup] (2/3) 検出入力 client_detect_clients.json を生成');
  phase('prepare-clients');
  await runPrepareClients();

  // 3) 検出入力に載るクライアントを clone し、既存も含めてテストしたときのコミット（commitId）に checkout する
  console.log('[setup] (3/3) クライアントを clonedata/clientRepos に clone・commitId にそろえる');
  await runCloneClients();

  console.log('[setup] 完了。以降は make run / make client-detect を実行できます');
}

main().catch(e => { logEvent('error', `[Fatal] ${e?.stack ?? e}`); console.error('[Fatal]', e); process.exit(1); });
