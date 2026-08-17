import type { ExtractFunctionCallsResult } from './ExtractFunctionCallsResult';
import type { ApiSymbol, ChangeTag, Confidence, LossCandidate } from './LibDiff';

/**
 * 生成した1パターン（更新後にクライアントが使うと壊れる実装の検出器）
 *   calls = R-BC 互換の呼び出し列 [binding, ...usage]（import/require 文と、その束縛を使う呼び出しをセットにしたもの）
 *   import 形が複数あるものは「1形 = 1 GeneratedPattern」に分ける（取りこぼし防止・寛容/厳密を形ごとに制御）
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
  calls: ExtractFunctionCallsResult[];  // [binding, usage...] R-BC の照合に渡す本体
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
}

/** 
 * 1タグ → 生成パターン群（import 形ごとに複数返る。該当しなければ空配列） 
 * それぞれの処理の担当に渡す前の処理
 */
export type TagConverter = (input: ConverterInput) => GeneratedPattern[];
