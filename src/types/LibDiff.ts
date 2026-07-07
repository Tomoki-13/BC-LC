// libDiff（段階1）共通型
// ライブラリ pre/post の API surface → 差分 → 損失候補（タグ + confidence）

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
}

// ---- 損失候補（差分結果。L2 で生成） ----

/** 変更種別タグ */
export type ChangeTag =
  | 'function-removed'
  | 'module-removed'
  | 'rename'
  | 'arg-added'
  | 'arg-removed'
  | 'arg-reordered'
  | 'arg-type-changed'
  | 'option-removed'       // options オブジェクトの受理キーが消えた（クライアントの指定が無視される）
  | 'option-added'         // options キー追加（加算的・参考）
  | 'return-changed'
  | 'spec-changed'
  | 'new-required'         // 関数 → class（new 必須化）等
  | 'sync-to-async'
  | 'export-style-changed' // cjs/esm・named/default の変化
  | 'module-format-changed'
  | 'deep-import-broken'
  | 'engines-changed'
  | 'dependency-changed';

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
  verdict?: 'loss' | 'review';  // 機能1(judgeLoss)の判定: loss=損失確定 / review=要確認
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
