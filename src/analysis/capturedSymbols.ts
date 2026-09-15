import fs from 'fs';
import path from 'path';

import OutputJson from '../utils/output_json';
import { PATTERNS_PATH, ANALYSIS_DIR, AUDIT_DIR, toCsvCell, PatternRecord } from '../utils/evalShared';

// 破壊的変更を見つけ、かつパターン化できた「関数/シンボル」を列挙する（何を捉えられているかの確認用）。
//   入力: patterns/patterns.json（生成パターン）＋ audit/dts_coverage.json（.d.ts 宣言との突合・任意）
//   出力: analysis/capturedSymbols/{summary.json, by_lib.json, captured_symbols.csv, dts_gap.csv}
//   目的: (1) どのシンボルがパターン化されたか（tag/confidence/importForm/件数）
//         (2) .d.ts が宣言する値 export のうち surface が捕捉できず patternize もできなかったもの（missing）

interface CapturedSymbol {
  symbol: string;
  tag: string;
  confidence: string;
  importForms: Set<string>;
  patternCount: number;
  pairs: Set<string>;
}
interface LibEntry {
  pairsWithPatterns: Set<string>;
  symbols: Map<string, CapturedSymbol>; // key = symbol|tag
  skippedTags: Map<string, number>;
}

interface DtsRecord { libName: string; version: string; hasDts: boolean; coverage?: number; missing?: string[] }

export function runCapturedSymbols(): void {
  const patternsPath = path.resolve(process.cwd(), PATTERNS_PATH);
  if (!fs.existsSync(patternsPath)) {
    console.error(`[capturedSymbols] ${patternsPath} が無い（先に make detect / make run）`);
    process.exit(1);
  }
  const records: PatternRecord[] = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));

  const byLib = new Map<string, LibEntry>();
  const tagTotals: Record<string, number> = {};       // tag → ユニークシンボル数
  const confTotals: Record<string, number> = {};      // confidence → ユニークシンボル数
  const seenSymbolGlobal = new Set<string>();          // lib|symbol|tag のユニーク集合

  for (const rec of records) {
    const lib = rec.npm_pkg;
    if (!byLib.has(lib)) byLib.set(lib, { pairsWithPatterns: new Set(), symbols: new Map(), skippedTags: new Map() });
    const entry = byLib.get(lib)!;
    const pairId = `${rec.prevVersion}__${rec.updatedVersion}`;

    for (const tag of rec.skippedTags) entry.skippedTags.set(tag, (entry.skippedTags.get(tag) ?? 0) + 1);
    if (rec.patterns.length > 0) entry.pairsWithPatterns.add(pairId);

    for (const p of rec.patterns) {
      const tag = String(p.tag);
      const key = `${p.symbol}|${tag}`;
      if (!entry.symbols.has(key)) {
        entry.symbols.set(key, { symbol: p.symbol, tag, confidence: p.confidence, importForms: new Set(), patternCount: 0, pairs: new Set() });
        const gkey = `${lib}|${key}`;
        if (!seenSymbolGlobal.has(gkey)) {
          seenSymbolGlobal.add(gkey);
          tagTotals[tag] = (tagTotals[tag] ?? 0) + 1;
          confTotals[p.confidence] = (confTotals[p.confidence] ?? 0) + 1;
        }
      }
      const sym = entry.symbols.get(key)!;
      sym.importForms.add(p.importForm);
      sym.patternCount++;
      sym.pairs.add(pairId);
    }
  }

  // .d.ts 突合（任意）: 宣言 export のうち surface 未捕捉（missing）を lib×版で集める
  const dtsPath = path.resolve(process.cwd(), AUDIT_DIR, 'dts_coverage.json');
  const dtsGap: { lib: string; version: string; coverage: number | null; missing: string[] }[] = [];
  if (fs.existsSync(dtsPath)) {
    try {
      const dts = JSON.parse(fs.readFileSync(dtsPath, 'utf-8'));
      for (const d of (dts.records ?? []) as DtsRecord[]) {
        if (d.hasDts && d.missing && d.missing.length > 0) {
          dtsGap.push({ lib: d.libName, version: d.version, coverage: d.coverage ?? null, missing: d.missing });
        }
      }
    } catch { /* dts_coverage 壊れは無視 */ }
  }

  const outDir = path.resolve(process.cwd(), ANALYSIS_DIR, 'capturedSymbols');
  OutputJson.createOutputDirectory(outDir);

  // by_lib.json（人が確認する主ファイル）
  const byLibOut: Record<string, unknown> = {};
  let totalSymbols = 0;
  for (const [lib, e] of byLib) {
    const symbols = [...e.symbols.values()]
      .map(s => ({ symbol: s.symbol, tag: s.tag, confidence: s.confidence, importForms: [...s.importForms].sort(), patternCount: s.patternCount, pairs: [...s.pairs].sort() }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.tag.localeCompare(b.tag));
    totalSymbols += symbols.length;
    byLibOut[lib] = {
      patternizedSymbolCount: symbols.length,
      pairsWithPatterns: e.pairsWithPatterns.size,
      skippedTags: Object.fromEntries([...e.skippedTags.entries()].sort()),
      symbols,
    };
  }
  fs.writeFileSync(path.join(outDir, 'by_lib.json'), JSON.stringify(byLibOut, null, 2));

  // captured_symbols.csv（lib × symbol × tag の1行）
  const csvRows = ['lib,symbol,tag,confidence,importFormCount,patternCount,pairCount'];
  for (const [lib, e] of byLib) {
    for (const s of e.symbols.values()) {
      csvRows.push([lib, s.symbol, s.tag, s.confidence, s.importForms.size, s.patternCount, s.pairs.size].map(toCsvCell).join(','));
    }
  }
  fs.writeFileSync(path.join(outDir, 'captured_symbols.csv'), csvRows.join('\n'));

  // dts_gap.csv（.d.ts 宣言のうち未捕捉のもの）
  const dtsRows = ['lib,version,coverage,missingCount,missing'];
  for (const g of dtsGap) {
    dtsRows.push([g.lib, g.version, g.coverage ?? '', g.missing.length, g.missing.join(' ')].map(toCsvCell).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'dts_gap.csv'), dtsRows.join('\n'));

  // summary.json
  const summary = {
    generatedAt: new Date().toISOString(),
    libs: byLib.size,
    patternizedSymbols: totalSymbols,      // lib×symbol×tag のユニーク数
    byTag: tagTotals,
    byConfidence: confTotals,
    dtsGap: { libsVersionsWithMissing: dtsGap.length, note: '.d.ts 宣言のうち surface 未捕捉（patternize 不能）' },
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`[capturedSymbols] libs=${byLib.size} patternizedSymbols=${totalSymbols} → ${outDir}`);
  console.log(`  byTag: ${Object.entries(tagTotals).map(([t, n]) => `${t}=${n}`).join(' ')}`);
  console.log(`  dts 未捕捉(lib×版): ${dtsGap.length}（dts_gap.csv）`);
}

// CLI 直接実行時のみ
if (process.argv[1] && /capturedSymbols\.(ts|js)$/.test(process.argv[1])) {
  runCapturedSymbols();
}
