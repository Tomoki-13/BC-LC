import type { ExtractFunctionCallsResult } from './ExtractFunctionCallsResult';

// R-BC / changeversion(ClientFixTrace) と同一スキーマの照合結果型。
// ネスト: EFCR=1行, EFCR[]=1ファイル群(binding+usage), EFCR[][]=1パターン, EFCR[][][]=パターン集合。

/** 命中した1パターンとその出現回数（R-BC PatternCount と同型） */
export interface PatternCount {
  pattern: ExtractFunctionCallsResult[][];
  count: number;
}

/** 1クライアントの命中記録（R-BC matchResults.json の1要素） */
export interface MatchClientPattern {
  client: string;                         // "owner/repo"（changeversion は末尾2セグメントで突合）
  pattern: ExtractFunctionCallsResult[];  // クライアント側の抽出結果（本実装は命中箇所の軽量記録）
  detectPattern: ExtractFunctionCallsResult[][]; // 命中した生成パターン
}

/** detect.json の基本形（R-BC DetectionOutput と同型） */
export interface DetectionOutput {
  patterns: PatternCount[];
  totalClients: number;
  detectedClients: string[];
}

/**
 * detect.json の拡張形（R-BC ExtendedDetectionOutput と同型。changeversion が読む契約）
 *   changeversion が実際に参照するのは totalClients と detectedClients のみ。
 *   test スクリプト分類系カウンタ(notest/standard/...)は BC-LC では未分類のため 0。
 */
export interface ExtendedDetectionOutput extends DetectionOutput {
  scannedDirCount: number;
  notestCount: number;
  standardCount: number;
  noscriptCount: number;
  noPackagejsonCount: number;
  validDetectedCount: number;
}
