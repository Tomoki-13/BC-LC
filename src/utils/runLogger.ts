import fs from 'fs';
import path from 'path';
import type { ResolveMethod } from '../types/LibDiff';

// tag/package-json は高信頼、git-head/commit-message は要目視確認
const RELIABLE: ResolveMethod[] = ['tag', 'package-json'];

interface ResolutionRec { lib: string; version: string; method: ResolveMethod; ref: string; }
interface EventRec { time: string; level: 'ERROR' | 'WARN'; lib: string; version: string; phase: string; message: string; }

/** 実行の監査ログを集約し、resolution_log.csv / <name>_run.log / <name>_run_summary.json に出力する */
export default class RunLogger {
  private resolutions: ResolutionRec[] = [];
  private events: EventRec[] = [];

  /** バージョン解決の結果を記録（method で信頼度が分かる） */
  resolution(lib: string, version: string, method: ResolveMethod, ref: string | null): void {
    this.resolutions.push({ lib, version, method, ref: ref ?? '' });
  }

  private event(level: 'ERROR' | 'WARN', lib: string, version: string, phase: string, message: string): void {
    const rec: EventRec = { time: new Date().toISOString(), level, lib, version, phase, message: message.replace(/\s+/g, ' ').trim().slice(0, 300) };
    this.events.push(rec);
    process.stderr.write(`\n[${level}] ${lib}@${version} (${phase}): ${rec.message}\n`);
  }
  error(lib: string, version: string, phase: string, message: string): void { this.event('ERROR', lib, version, phase, message); }
  warn(lib: string, version: string, phase: string, message: string): void { this.event('WARN', lib, version, phase, message); }

  /** 監査ファイル3種を outDir に書き出す */
  flush(outDir: string, name: string): void {
    fs.mkdirSync(outDir, { recursive: true });

    const needsCheck = (m: ResolveMethod) => !RELIABLE.includes(m); // git-head/commit-message/unresolved
    const csv = ['lib,version,method,ref,needs_check']
      .concat(this.resolutions.map(r => `${r.lib},${r.version},${r.method},${r.ref.slice(0, 12)},${needsCheck(r.method)}`))
      .join('\n');
    fs.writeFileSync(path.join(outDir, 'resolution_log.csv'), csv);

    const logLines = this.events.map(e => `${e.time} [${e.level}] ${e.lib}@${e.version} (${e.phase}): ${e.message}`);
    fs.writeFileSync(path.join(outDir, `${name}_run.log`), logLines.join('\n') + (logLines.length ? '\n' : ''));

    const byMethod: Record<string, number> = {};
    for (const r of this.resolutions) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
    const summary = {
      totalResolutions: this.resolutions.length,
      byMethod,
      needsCheck: this.resolutions.filter(r => needsCheck(r.method))
        .map(r => ({ lib: r.lib, version: r.version, method: r.method, ref: r.ref.slice(0, 12) })),
      errors: this.events.filter(e => e.level === 'ERROR').length,
      warnings: this.events.filter(e => e.level === 'WARN').length,
      events: this.events,
    };
    fs.writeFileSync(path.join(outDir, `${name}_run_summary.json`), JSON.stringify(summary, null, 2));

    process.stderr.write(
      `\n[runLogger] 解決 ${this.resolutions.length}件 手段別=${JSON.stringify(byMethod)} / 要確認 ${summary.needsCheck.length}件 / ERROR ${summary.errors} WARN ${summary.warnings}\n` +
      `  → ${path.join(outDir, 'resolution_log.csv')}\n  → ${path.join(outDir, name + '_run.log')}\n  → ${path.join(outDir, name + '_run_summary.json')}\n`
    );
  }
}
