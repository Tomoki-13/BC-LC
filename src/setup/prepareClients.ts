import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import { TEST_RESULT_PATH, CLIENTS_PATH } from '../utils/evalShared';

// client-detect の検出入力 clients.json を datasets に用意する（setup 段。make prepare-clients）。
//   版ペアは proposal_result、クライアントは test_result（S=依存 repo）から取る。
//   clients.json は state を持たない（検出入力を結果フリーにする）。採点 GT は元 test_result を直接参照。
//   dataset の性質上、両版に観測があるエントリは prevVersion が必ず success（詳細は datasets/README.md）。

const PROPOSAL_PATH = '../../datasets/proposal_result.json';

interface TestRow { L__npm_pkg: string; S__nameWithOwner: string; S__commit_id: string; L__version: string; state: 'success' | 'failure'; }
interface Proposal { npm_pkg: string; prev: { version: string }; updated: { version: string }; }
interface ClientEntry { npm_pkg: string; prevVersion: string; updatedVersion: string; client: string; commitId: string; }

export async function runPrepareClients(): Promise<void> {
  const testResult: TestRow[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), TEST_RESULT_PATH), 'utf-8'));
  const proposal: Proposal[] = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), PROPOSAL_PATH), 'utf-8'));

  // idx[lib][client][version] = { state, commitId }（state は正例数のログ表示にのみ使い、clients.json には出さない）
  const idx = new Map<string, Map<string, Map<string, { state: string; commitId: string }>>>();
  for (const r of testResult) {
    if (!idx.has(r.L__npm_pkg)) idx.set(r.L__npm_pkg, new Map());
    const byC = idx.get(r.L__npm_pkg)!;
    if (!byC.has(r.S__nameWithOwner)) byC.set(r.S__nameWithOwner, new Map());
    byC.get(r.S__nameWithOwner)!.set(r.L__version, { state: r.state, commitId: r.S__commit_id });
  }

  // 版ペア（proposal 由来・重複排除）
  const seen = new Set<string>();
  const pairs: { npm_pkg: string; prev: string; updated: string }[] = [];
  for (const e of proposal) {
    const k = `${e.npm_pkg}|${e.prev.version}|${e.updated.version}`;
    if (seen.has(k)) continue; seen.add(k);
    pairs.push({ npm_pkg: e.npm_pkg, prev: e.prev.version, updated: e.updated.version });
  }

  const clients: ClientEntry[] = [];
  let positives = 0; // ログ用のみ（clients.json には書かない）
  for (const p of pairs) {
    const byC = idx.get(p.npm_pkg);
    if (!byC) continue;
    for (const [client, verMap] of byC) {
      const atPrev = verMap.get(p.prev), atUpd = verMap.get(p.updated);
      if (!atPrev || !atUpd) continue; // 両版に観測がある＝この遷移で評価可能な依存メンバー（prev は上記性質で必ず success）
      clients.push({ npm_pkg: p.npm_pkg, prevVersion: p.prev, updatedVersion: p.updated, client, commitId: atUpd.commitId });
      if (atPrev.state === 'success' && atUpd.state === 'failure') positives++;
    }
  }

  const clientsPath = path.resolve(process.cwd(), CLIENTS_PATH);
  OutputJson.createOutputDirectory(path.dirname(clientsPath));
  fs.writeFileSync(clientsPath, JSON.stringify(clients, null, 2));
  console.log(`[prepareClients] pairs=${pairs.length} / 検出入力(結果なし)=${clients.length} → ${clientsPath}`);
  console.log(`[prepareClients] （参考）採点時の正例 prev成功→updated失敗=${positives}。GT は元 test_result を採点で直接参照`);
}

// CLI 直接実行時のみ走らせる（setup.ts から import された時は走らせない）
if (process.argv[1] && /prepareClients\.(ts|js)$/.test(process.argv[1])) {
  runPrepareClients().catch(e => { console.error('[Fatal]', e); process.exit(1); });
}
