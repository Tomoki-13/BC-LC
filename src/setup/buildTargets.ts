import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import { initRunLog, logEvent } from '../utils/runLog';

// パターン生成の版ペア入力 targets.all.json を datasets に用意する（setup 段。make build-targets）。
//   版ペアは proposal_result.json の記録 (prev.version, updated.version) をそのまま採用（dedup）。
//   自動算出（resolvePreviousVersion）は安定版 target からプレリリース prev を除外して取り違えるため使わない。
//   prev は記録通り（例 uuid 8.0.0-beta.0 → 8.0.0）で、検出入力 client_detect_clients.json と 1:1 整合する。

const PROPOSAL_PATH = '../../datasets/proposal_result.json';
const TARGETS_OUT = '../../datasets/targets.all.json';

interface Proposal { npm_pkg: string; prev: { version: string }; updated: { version: string }; }
interface Target { libName: string; preVersion: string; postVersion: string; }

export async function runBuildTargets(): Promise<void> {
  const proposalPath = path.resolve(process.cwd(), PROPOSAL_PATH);
  const proposal: Proposal[] = JSON.parse(fs.readFileSync(proposalPath, 'utf-8'));

  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const e of proposal) {
    const key = `${e.npm_pkg}|${e.prev.version}|${e.updated.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ libName: e.npm_pkg, preVersion: e.prev.version, postVersion: e.updated.version });
  }

  const outPath = path.resolve(process.cwd(), TARGETS_OUT);
  OutputJson.createOutputDirectory(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(targets, null, 2));

  const libs = new Set(targets.map(t => t.libName)).size;
  console.log(`[buildTargets] 記録ペア(dedup)=${targets.length} lib=${libs} → ${outPath}`);
}

// CLI 直接実行時のみ走らせる（setup.ts から import された時は走らせない）
if (process.argv[1] && /buildTargets\.(ts|js)$/.test(process.argv[1])) {
  initRunLog('build-targets');
  runBuildTargets().catch(e => { logEvent('error', `[Fatal] ${e?.stack ?? e}`); console.error('[Fatal]', e); process.exit(1); });
}
