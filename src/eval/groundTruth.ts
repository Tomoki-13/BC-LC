import fs from 'fs';
import path from 'path';
import OutputJson from '../utils/output_json';

const PROPOSAL = '../../datasets/proposal_result.json';
const OUT_DIR = '../../outputs/latest/BC-LC/eval';

interface GroundTruth {
  npm_pkg: string;
  nameWithOwner: string;
  prevVersion: string;
  updatedVersion: string;
  state: 'success' | 'failure';
  loss: boolean;          // 損失あり = state==='failure'
  isBreaking: boolean;    // 参考: proposal ツールの予測値（正解ではない）
  failCount: number;      // stats.failure（何クライアントで失敗したか）
  succCount: number;      // stats.success
}

function main(): void {
  const p = path.resolve(process.cwd(), PROPOSAL);
  if (!fs.existsSync(p)) { console.error(`[Error] 見つかりません: ${p}（make clone-dataset を先に）`); process.exit(1); }

  const arr = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
  const list: GroundTruth[] = arr
    .filter(e => e && e.npm_pkg && e.prev?.version && e.updated?.version && (e.state === 'success' || e.state === 'failure'))
    .map(e => ({
      npm_pkg: e.npm_pkg,
      nameWithOwner: e.nameWithOwner,
      prevVersion: e.prev.version,
      updatedVersion: e.updated.version,
      state: e.state,
      loss: e.state === 'failure',
      isBreaking: !!e.isBreaking,
      failCount: e.stats?.failure ?? 0,
      succCount: e.stats?.success ?? 0,
    }));

  const outDir = path.resolve(process.cwd(), OUT_DIR);
  OutputJson.createOutputDirectory(outDir);

  // JSON
  fs.writeFileSync(path.join(outDir, 'ground_truth.json'), JSON.stringify(list, null, 2));

  // CSV
  const header = 'npm_pkg,nameWithOwner,prevVersion,updatedVersion,state,loss,isBreaking,failCount,succCount\n';
  const rows = list.map(g =>
    `${g.npm_pkg},${g.nameWithOwner},${g.prevVersion},${g.updatedVersion},${g.state},${g.loss},${g.isBreaking},${g.failCount},${g.succCount}`
  ).join('\n');
  fs.writeFileSync(path.join(outDir, 'ground_truth.csv'), header + rows);

  // サマリ
  const failure = list.filter(g => g.loss).length;
  const success = list.length - failure;
  const libs = new Set(list.map(g => g.npm_pkg)).size;
  console.log(`[GroundTruth] 総数=${list.length}  success(損失なし)=${success}  failure(損失あり)=${failure}  ユニークlib=${libs}`);
  console.log(`[Done] ${outDir}/ground_truth.{json,csv}`);
}

main();
