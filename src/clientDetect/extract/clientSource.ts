import fs from 'fs';
import getAllFiles from '../../utils/getAllFiles';

// ライブラリ側 surface（テスト除外）と違い、第2引数 includeTests=true で test/spec も含める

const MAX_BYTES = 600 * 1024; // 巨大な生成物/データファイルは除外

/** repo 配下の解析対象ファイルの絶対パスを列挙（test 含む・useAst の入力用）。repo が無ければ null */
export async function listClientFilePaths(repoDir: string): Promise<string[] | null> {
  if (!fs.existsSync(repoDir)) return null;

  let files: string[];
  try {
    files = await getAllFiles(repoDir, true); // クライアント側はテストも含める
  } catch {
    return []; // 走査中の I/O エラーは空扱い（未クローンは上の null で区別）
  }

  // 巨大な生成/データファイルは除外
  return files.filter(filePath => {
    try {
      return fs.statSync(filePath).size <= MAX_BYTES;
    } catch {
      return false;
    }
  });
}
