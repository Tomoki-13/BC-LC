// 実行モード（API の範囲 SCOPE × 検出の粒度 DETECT）と、それを表す出力フォルダ名
//   make run SCOPE=… DETECT=… → 環境変数 BCLC_SCOPE / BCLC_DETECT（Makefile の run_logged が渡す）

/**
 * API の範囲（どの export を外部 API とみなして損失判定・パターン生成するか）
 *   all     : 全 export
 *   doc     : リポジトリ内の全 .md（README・CHANGELOG・docs/ 以下など。node_modules・.git は除く）の本文に、
 *             export 名と文字列で一致する語があるもの（ApiScope.collectDocTokens）
 *   test    : テストファイルが import して使う名前（ApiScope.collectTestUsage）
 *   doctest : doc と test のどちらかに当たるもの
 * package.json 由来の損失（engines・type・files・exports）は名前に関係しないので、どの範囲でも残る
 */
export type ApiScopeName = 'all' | 'doc' | 'test' | 'doctest';
const SCOPES: ApiScopeName[] = ['all', 'doc', 'test', 'doctest'];

/** SCOPE= の値を範囲にする。空なら all */
export function parseScope(value: string | undefined): ApiScopeName {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return 'all';
  if ((SCOPES as string[]).includes(v)) return v as ApiScopeName;
  throw new Error(`SCOPE=${value} は無効（all・doc・test・doctest）`);
}

/**
 * 検出の粒度（積み上げ式）。何に当たれば「検出」とするか
 *   1 code   : ソースコードのパターン
 *   2 config : ＋設定ファイル（CI 設定・engines・.nvmrc から推定した Node のバージョンが、引き上げられた下限を下回る）
 *   3 pkg    : ＋package.json の依存に直接書いてある（コードで読み込んでいないクライアント）
 *   4 all    : ＋ロックファイルに載っている・registry で依存の依存（2段まで）に届く
 * 依存の経路は粒度 3・4 のときだけたどる（1・2 では読まない・npm registry にも接続しない）。結果は clients_detail.csv の library_link に残す
 */
export type DetectLevel = 1 | 2 | 3 | 4;
export const DEFAULT_DETECT_LEVEL: DetectLevel = 2;
export const DETECT_LEVEL_NAME: Record<DetectLevel, string> = { 1: 'code', 2: 'config', 3: 'pkg', 4: 'all' };

/** DETECT= の値（1〜4 または code / config / pkg / all）を粒度にする。空なら既定 */
export function parseDetectLevel(value: string | undefined): DetectLevel {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return DEFAULT_DETECT_LEVEL;
  const byName = Object.entries(DETECT_LEVEL_NAME).find(([, name]) => name === v);
  const level = byName ? Number(byName[0]) : Number(v);
  if (level === 1 || level === 2 || level === 3 || level === 4) return level;
  throw new Error(`DETECT=${value} は無効（1|code・2|config・3|pkg・4|all）`);
}

/** この実行のモード（環境変数から） */
export const RUN_SCOPE: ApiScopeName = parseScope(process.env.BCLC_SCOPE);
export const RUN_DETECT_LEVEL: DetectLevel = parseDetectLevel(process.env.BCLC_DETECT);

/** 出力フォルダ名に使うモードの名前（例 scope-all_detect-config）。Makefile の VARIANT と同じ規則 */
export const RUN_VARIANT = `scope-${RUN_SCOPE}_detect-${DETECT_LEVEL_NAME[RUN_DETECT_LEVEL]}`;
