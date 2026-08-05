// ---- API surface（pre/post 各バージョンの外部 API） ----

/** export の束縛形態 */
export type ExportStyle =
  | 'cjs-module-default'   // module.exports = X
  | 'cjs-property'         // module.exports.foo / exports.foo
  | 'esm-named'            // export function foo / export const foo / export { foo }
  | 'esm-default'          // export default
  | 'esm-reexport'         // export { x } from '...' / export * from '...'
  | 'unknown';

/** シンボルの種別 */
export type SymbolKind = 'function' | 'class' | 'value' | 'getter' | 'unknown';

/** 外部 API として観測した 1 シンボル */
export interface ApiSymbol {
  name: string;            // export 名（default は 'default'）
  kind: SymbolKind;
  exportStyle: ExportStyle;
  params?: string[];       // function / class constructor の引数名（arity・名称比較用 / 型は含めない）
  returnExprs?: string[];  // return 文の式（同一シグネチャでの仕様変更検出に使用）
  isAsync?: boolean;       // async 関数か（await 要否＝同期/非同期の変化検出に使用）
  accessPath?: string;     // プロパティ経由の公開パス（例 "uuid.v4"）。直接 export は undefined
  optionKeys?: string[];   // 関数が消費する options オブジェクトのキー（分割代入 or opts.key 読み取り）
  filePath: string;        // repo 相対パス
}

/** あるバージョンの API surface */
export interface ApiSurface {
  version: string;
  tag: string;             // 解決済み git タグ
  scope: 'export' | 'all'; // 選択肢A=export / 選択肢C=全 top-level
  symbols: ApiSymbol[];
  engines?: { node?: string; npm?: string }; // package.json engines（必要ランタイム版・range 文字列）
}

// ---- 損失候補（差分結果。L2 で生成） ----

/**
 * 変更種別タグ（後方互換性の損失カタログ）
 *   全タグは記録として candidates に残すが、実際に損失として数えるのは LOSS_TAGS のみ
 *   （rename は旧名の消失として function-removed/export-removed に含まれるため独立タグは持たない）
 */
export type ChangeTag =
  // --- 損失として扱う（LOSS_TAGS）---
  | 'function-removed'       // export 関数の削除（呼び出し不可）
  | 'export-removed'         // 非関数 export（変数/値/object メンバ）の削除（参照不可）
  | 'module-removed'         // モジュール(サブパス)の削除
  | 'deep-import-broken'     // 内部パス移動で deep import が壊れる
  | 'arg-reordered'          // 引数の並び替え（位置がずれる＝破壊的）
  | 'arg-removed'            // 引数の削除（中間の引数が消えると後続の位置引数がずれて破壊的）
  | 'sync-to-async'          // 同期→非同期（await 要否が変わる）
  | 'new-required'           // new 必須化/禁止化（関数 → class 等）
  | 'module-format-changed'  // CJS/ESM の変更
  | 'option-removed'         // options キーの削除（クライアントの指定が無視される）
  | 'export-style-changed'   // 公開形/accessPath の変化（cjs/esm・named/default・プロパティ経由）
  | 'return-changed'         // 返り値・仕様の変更（同一シグネチャ）
  | 'node-npm-requirement-raised' // engines 引き上げ（それ未満の利用者が install/実行不可）
  // --- 記録のみ（損失と言い切れないため LOSS_TAGS から除外）---
  | 'option-added'           // options キー追加＝加算的で非破壊。損失ではないが記録として保持
  | 'arg-added'              // 引数の増加。TODO: 追加引数が必須のときだけ破壊だが、現状 必須/任意 の判別が難しく損失に数えない
  | 'arg-type-changed'       // 引数の型変更。TODO: R-BC 同様の型分析で兆候は見られそうだが誤検出が多そうなため今後
  | 'spec-changed'           // 仕様変更（曖昧・意味的な受け皿）
  | 'dependency-changed';    // 依存の変更。TODO: 未導入。間接依存の影響で損失につながる場合もある（間接依存 Phase）

/**
 * 実際に後方互換性の損失として扱うタグ（core の損失判定 judgeLoss とパターン生成 generatePatterns はこれで絞る）
 *   ここに無いタグ（option-added / arg-added / arg-type-changed / spec-changed / dependency-changed）は
 *   candidates に記録として残すが、損失には数えずパターンも作らない
 */
export const LOSS_TAGS: ReadonlySet<ChangeTag> = new Set<ChangeTag>([
  'function-removed', 'export-removed', 'module-removed', 'deep-import-broken',
  'arg-reordered', 'arg-removed', 'sync-to-async', 'new-required', 'module-format-changed',
  'option-removed', 'export-style-changed', 'return-changed', 'node-npm-requirement-raised',
]);

/** 静的検出の確信度 */
export type Confidence =
  | 'structural'           // 構造的に確実（削除・arity・new 必須化 等）
  | 'semantic';            // 意味的・要裏付け（仕様変更・検証強化 等）

/** バージョン→ref をどの手段で解決したか（監査用。tag/package-json が高信頼） */
export type ResolveMethod = 'tag' | 'package-json' | 'git-head' | 'commit-message' | 'unresolved';

/** 外部API絞り込みモード（0=絞り込みなし / 1=test由来 / 2=README由来 / 3=全md由来） */
export type ScopeMode = 0 | 1 | 2 | 3;

/** 対象ライブラリの import を追跡して得た「実際に使われた API」 */
export interface ApiUsage {
  named: Set<string>;      // 名前付き export / プロパティ呼び出し名
  defaultUsed: boolean;    // デフォルト export を直接使用
  deepPaths: Set<string>;  // deep import のサブパス（例 'lib/util'）
}

/** 損失候補 1 件（libDiff=差分取得 の出力 / core 機能1 の入出力） */
export interface LossCandidate {
  libName: string;
  preVersion: string;
  postVersion: string;
  symbol: string;          // 対象 export 名
  filePath: string;
  tag: ChangeTag;
  label: string;           // 損失内容の説明（どんな後方互換性損失かが分かるラベル）
  confidence: Confidence;
  verdict?: 'loss';        // 機能1(judgeLoss): 全候補を loss と判定。確実/要確認は confidence 参照
  detail?: string;         // 補足（before/after の要約など）
}

/** 機能2 の出力: 損失をパターン化したもの（P1 形式 + 変更種別タグ） */
export interface LossPattern {
  libName: string;
  preVersion: string;
  postVersion: string;
  symbol: string;
  tag: ChangeTag;
  confidence: Confidence;
  pattern: string;         // P1 と同形式の記述パターン（生成方法は機能2で実装）
}

// ---- collectDataset の lib_diff.json（入力） ----

export interface ChangedFile { status: string; file: string; }

export interface LibDiffInput {
  libraryName: string;
  preVersion: string;
  postVersion: string;
  preTag: string;
  postTag: string;
  repoUrl: string;
  changedFiles: ChangedFile[];
  diffPath: string;
}
