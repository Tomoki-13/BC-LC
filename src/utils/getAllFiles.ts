import fs from 'fs/promises';
import path from 'path';

const SOURCE_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.cjs', '.mjs']);
const EXCLUDED_SUFFIXES = ['.min.js', '.dev.js', '.lib.js', '.lib.ts', '.bundle.js'];
const EXCLUDED_FILENAMES = new Set(['.DS_Store']);
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage']);
const TEST_DIRECTORIES = new Set(['__tests__', '__mocks__', 'test', 'tests', 'spec', 'specs', 'fixture', 'fixtures', '__fixtures__']);
// 素の test.js / spec.js も foo.test.js / foo.spec.ts も拾う（apiScope.isTestFile と統一）
const TEST_FILE_RE = /(^|\.)(test|spec)\.[cm]?[jt]sx?$/;

/** 解析対象の拡張子か、かつミニファイ/除外ファイル名でないか */
const isAnalyzableSourceFile = (filePath: string): boolean => {
  const fileName = path.basename(filePath);
  if (!SOURCE_EXTENSIONS.has(path.extname(fileName))) return false;
  if (EXCLUDED_SUFFIXES.some(suffix => fileName.endsWith(suffix))) return false;
  if (EXCLUDED_FILENAMES.has(fileName)) return false;
  return true;
};

/** テスト/フィクスチャ ディレクトリ配下 or テスト用ファイル名か */
const isTestPath = (filePath: string): boolean => {
  const fileName = path.basename(filePath);
  const segments = filePath.split(path.sep);
  const inTestDir = segments.some(segment => TEST_DIRECTORIES.has(segment));
  const isTestFileName = TEST_FILE_RE.test(fileName);
  return inTestDir || isTestFileName;
};

/**
 * ディレクトリ配下の「解析対象ソースファイル」を再帰列挙する
 * 入力: directoryPath（走査起点）/ includeTests（テストも含めるか。既定 false＝ライブラリ surface 向け）
 * 出力: 絶対/相対パスの配列（node_modules・dist・.git 等・ミニファイは常に除外）
 *   ライブラリ surface は includeTests=false（ノイズ源のテストを除外）、
 *   クライアント照合は includeTests=true（クライアントのテストこそ破壊で壊れるため）。
 */
const getAllFiles = async (directoryPath: string, includeTests = false): Promise<string[]> => {
  const collected: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error('Error reading directory:', err);
      throw err;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (!isAnalyzableSourceFile(entryPath)) continue;
        if (!includeTests && isTestPath(entryPath)) continue;
        collected.push(entryPath);
      } else if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (!includeTests && TEST_DIRECTORIES.has(entry.name)) continue;
        await walk(entryPath);
      }
    }
  };

  await walk(directoryPath);
  return collected;
};

export default getAllFiles;
