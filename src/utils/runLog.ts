import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import { execSync } from 'child_process';

import OutputJson from './output_json';

// 実行ログ（出力先 = 環境変数 BCLC_LOG_DIR。make 経由なら history/<ラベル>/<RUN_ID>[-目印]/logs、直接実行なら history/adhoc/<日時>/logs）
//   run.log       : 標準出力・標準エラーの全文（make の tee が書く。プロセスが落ちても最後の出力まで残る）
//   errors.jsonl  : エラー・警告を1件1行で即時追記（どの段階・lib・版ペア・クライアントで起きたかを付ける）
//   progress.json : 処理中の段階と lib・版ペア・クライアント（逐次上書き。落ちた地点の特定用）
//   run_info.json : 開始/終了時刻・コマンド・git commit・Node 版・ヒープ上限・段階ごとの所要時間・終了状態
//     status は running → completed / failed。OOM 等で強制終了すると running のまま残る（異常終了の印）

interface Phase { name: string; startedAt: string; endedAt?: string; seconds?: number }
type Level = 'error' | 'warn' | 'log';

interface RunInfo {
  runId: string;
  entry: string;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  gitCommit: string;
  gitDirty: boolean;
  node: string;
  heapLimitMB: number;
  phases: Phase[];
  eventCounts: Record<Level, number>;
}

let logDir: string | null = null;
let info: RunInfo | null = null;
let context: Record<string, unknown> = {};

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function writeInfo(): void {
  if (!logDir || !info) return;
  fs.writeFileSync(path.join(logDir, 'run_info.json'), JSON.stringify(info, null, 2));
}

function endPhase(): void {
  const current = info?.phases[info.phases.length - 1];
  if (!current || current.endedAt) return;
  current.endedAt = new Date().toISOString();
  current.seconds = (Date.parse(current.endedAt) - Date.parse(current.startedAt)) / 1000;
}

const currentPhase = (): string => info?.phases[info.phases.length - 1]?.name ?? '';

/** 実行ログを開始する。一括実行から各段を呼ぶ場合は最初の初期化を使い続ける（2回目以降は何もしない） */
export function initRunLog(entry: string): void {
  if (logDir) return;
  const runId = process.env.BCPG_RUN_ID ?? OutputJson.formatDateTime(new Date());
  logDir = path.resolve(process.cwd(), process.env.BCLC_LOG_DIR ?? `../../outputs/history/adhoc/${runId}/logs`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'errors.jsonl'), ''); // 0件でもファイルを置く（無い＝記録漏れと区別するため）
  info = {
    runId,
    entry,
    command: process.argv.slice(1).join(' '),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    status: 'running',
    gitCommit: git('rev-parse --short HEAD'),
    gitDirty: git('status --porcelain') !== '',
    node: process.version,
    heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
    phases: [],
    eventCounts: { error: 0, warn: 0, log: 0 },
  };
  writeInfo();
  // 正常終了・process.exit のどちらでも終了状態を確定する（OOM の強制終了ではここに来ない）
  process.on('exit', (code) => {
    if (!info) return;
    endPhase();
    info.status = code === 0 ? 'completed' : 'failed';
    info.exitCode = code;
    info.endedAt = new Date().toISOString();
    writeInfo();
  });
  console.log(`[log] 実行ログ → ${logDir}`);
}

/** 段階の切り替え（前の段階を閉じて所要時間を記録） */
export function phase(name: string): void {
  if (!info) return;
  endPhase();
  info.phases.push({ name, startedAt: new Date().toISOString() });
  context = {};
  writeInfo();
  progress({});
}

/** 処理中の位置を記録する（lib・版ペア・クライアント等）。errors.jsonl の各行にもこの位置が付く */
export function progress(ctx: Record<string, unknown>): void {
  context = ctx;
  if (!logDir) return;
  fs.writeFileSync(path.join(logDir, 'progress.json'),
    JSON.stringify({ phase: currentPhase(), ...ctx, updatedAt: new Date().toISOString() }, null, 2));
}

/** エラー・警告を1件追記する（即時書き込みなので途中で落ちても残る） */
export function logEvent(level: Level, message: string, extra: Record<string, unknown> = {}): void {
  if (info) info.eventCounts[level]++;
  if (!logDir) return;
  const rec = { time: new Date().toISOString(), level, phase: currentPhase(), ...context, ...extra, message: message.slice(0, 2000) };
  fs.appendFileSync(path.join(logDir, 'errors.jsonl'), JSON.stringify(rec) + '\n');
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return (a.stack ?? a.message).split('\n').slice(0, 4).join(' | ');
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** fn 実行中の console.log/warn/error を画面に出さず errors.jsonl に回す（クライアント抽出時の大量のパース警告対策） */
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const route = (level: Level) => (...args: unknown[]) => logEvent(level, args.map(formatArg).join(' '));
  console.log = route('log');
  console.warn = route('warn');
  console.error = route('error');
  try {
    return await fn();
  } finally {
    Object.assign(console, original);
  }
}

/** これまでに記録したイベント件数と出力先（実行末尾の要約表示用） */
export function runLogSummary(): { dir: string | null; counts: Record<Level, number> } {
  return { dir: logDir, counts: info?.eventCounts ?? { error: 0, warn: 0, log: 0 } };
}
