import type { ExtractFunctionCallsResult } from './ExtractFunctionCallsResult';
import type { ApiSymbol, ChangeTag, Confidence, LossCandidate } from './LibDiff';

/**
 * 環境述語（PatternKind=environment）。コード正規表現に落ちない損失の検出条件。
 *   node-engine: ライブラリが要求する Node 下限。client の使用 Node 版が requiredMin 未満なら壊れる
 */
export interface EnvPredicate {
  kind: 'node-engine';
  field: string;        // 対象 engines フィールド（'engines.node'）
  requiredMin: string;  // post 版の要求下限 semver（例 "8.0.0"）
}

/**
 * 生成した1パターン（更新後にクライアントが使うと壊れる実装の検出器）
 *   calls = R-BC 互換の呼び出し列 [binding, ...usage]（import/require 文と、その束縛を使う呼び出しをセットにしたもの）
 *   import 形が複数あるものは「1形 = 1 GeneratedPattern」に分ける（取りこぼし防止・寛容/厳密を形ごとに制御）
 *   env を持つパターンは code-usage 照合ではなく環境照合（client の設定ファイルから Node 版を判定）で扱う。calls は空
 */
export interface GeneratedPattern {
  libName: string;
  preVersion: string;
  postVersion: string;
  symbol: string;                       // 対象 export 名
  tag: ChangeTag;
  label: string;                        // BC-LC のラベル（labelOf(tag)。どの損失のパターンか判別用）
  confidence: Confidence;
  importForm: string;                   // 狙った import 形（cjs-require / esm-default / esm-named 等・監査用）
  calls: ExtractFunctionCallsResult[];  // [binding, usage...] R-BC の照合に渡す本体（env パターンでは空）
  env?: EnvPredicate;                   // 環境述語（node-engine 等）。ある場合は環境照合で判定
}

/**
 * 1タグ分の変換器への入力
 *   preSymbol  pre 版の該当シンボル（arity/exportStyle/accessPath を参照して import 形を選ぶ）
 *   postSymbol post 版の該当シンボル（arg 変化等で使用。削除系タグでは undefined）
 */
export interface ConverterInput {
  candidate: LossCandidate;
  preSymbol: ApiSymbol;
  postSymbol?: ApiSymbol;
  engines?: { pre?: { node?: string; npm?: string }; post?: { node?: string; npm?: string } }; // 環境系タグ用（package.json engines）
}

/**
 * 1タグ → 生成パターン群（import 形ごとに複数返る。該当しなければ空配列）
 * それぞれの処理の担当に渡す前の処理
 */
export type TagConverter = (input: ConverterInput) => GeneratedPattern[];

/** パターンが1件も出なかった候補 */
export interface SkippedCandidate {
  tag: string;
  symbol: string;
}

/** generatePatterns の出力（生成パターンと、パターン化しなかった候補） */
export interface GenerateResult {
  patterns: GeneratedPattern[];
  skipped: SkippedCandidate[];
}
