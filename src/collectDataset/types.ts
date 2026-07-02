// ==========================================
// collectDataset 共通型
// ------------------------------------------
// データセット収集（特定バージョンの「一つ前」を使うクライアント収集
// ＋ ライブラリ本体の更新前後バージョン取得・差分）で用いる型定義
// ==========================================

/** 収集の実行設定 */
export interface CollectConfig {
  /** 対象ライブラリ名（npm パッケージ名） 例: "next" */
  libraryName: string;
  /** 調べたい更新後バージョン（post） 例: "2.0.0" */
  targetVersion: string;
  /** 集めるクライアント数の上限 */
  numberOfRepos: number;
  /** プレリリース（例 2.0.0-beta.0）を「一つ前」の候補に含めるか（既定 false） */
  includePrerelease?: boolean;
}

/** npm registry から解決したバージョン情報 */
export interface ResolvedVersions {
  libraryName: string;
  /** 更新後（= targetVersion を正規化したもの） */
  postVersion: string;
  /** 更新前（registry 上で post の直前に公開された版） */
  preVersion: string;
  /** semver 昇順に並べた候補バージョン一覧 */
  candidateVersions: string[];
}

/** 収集対象として採用したクライアント */
export interface ClientHit {
  /** owner/repo */
  fullName: string;
  /** リポジトリ内の package.json パス */
  packageJsonPath: string;
  /** 対象ライブラリの宣言された依存レンジ 例: "^1.4.0" */
  declaredRange: string;
  /** dependencies / devDependencies いずれで宣言されているか */
  depType: 'dependencies' | 'devDependencies';
  /** 品質指標（収集時点のスナップショット） */
  stars?: number;
  forks?: number;
  pushedAt?: string;
}

/** 変更ファイル 1 件 */
export interface ChangedFile {
  /** git の name-status（A/M/D/R... ） */
  status: string;
  file: string;
}

/** ライブラリ本体 pre/post の差分取得結果 */
export interface LibDiffResult {
  libraryName: string;
  preVersion: string;
  postVersion: string;
  /** 実際に解決された git タグ名（例 v2.0.0 / 2.0.0） */
  preTag: string;
  postTag: string;
  /** クローン元 https URL */
  repoUrl: string;
  /** 変更されたファイル一覧（name-status） */
  changedFiles: ChangedFile[];
  /** 保存した unified diff (.patch) のパス */
  diffPath: string;
}
