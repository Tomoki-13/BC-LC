import * as path from 'path';
import { CallModuleAndFuncList } from '../../../types/ModuleList';
import { getImportAndPath } from '../../../utils/getImportAndPath';
import { OutboundFileDependencies } from '../../../types/FileDependencies';

// 解析対象とするファイルの拡張子
const SUPPORTED_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];

/**
 * プロジェクト内の全ファイルパスを受け取り、ファイルの依存関係グラフを構築する
 * @param all_filePaths プロジェクト内の全ファイルパスの配列
 * @returns ファイルごとの（アウトバウンド）依存関係の配列
 */
export function getFileRelated(all_filePaths: string[]): OutboundFileDependencies[] {
  const relevantFiles = all_filePaths.filter((filePath) => SUPPORTED_EXTENSIONS.some((ext) => filePath.endsWith(ext)));
  const allCalledUserFunc: CallModuleAndFuncList[] = relevantFiles.flatMap((filePath) =>
    getImportAndPath(filePath, 0) as CallModuleAndFuncList[]
  );
  return getDependRelated(allCalledUserFunc);
}

// 呼び出し関係の生データを受け取り、ファイルごとの依存関係に整理する
function getDependRelated(data: CallModuleAndFuncList[]): OutboundFileDependencies[] {
  const resultMap = new Map<string, Map<string, Set<string>>>();

  for (const item of data) {
    // ライブラリ（例: 'react', 'fs'）を除外し、相対パスのみを対象とする
    if (!item.call_modulename.startsWith('.')) {
      continue;
    }

    const sourceFile = path.resolve(item.path);
    const resolvedDepPath = path.resolve(path.dirname(sourceFile), item.call_modulename);

    if (!resultMap.has(sourceFile)) {
      resultMap.set(sourceFile, new Map<string, Set<string>>());
    }
    const depMap = resultMap.get(sourceFile)!;

    if (!depMap.has(resolvedDepPath)) {
      depMap.set(resolvedDepPath, new Set<string>());
    }
    const funcSet = depMap.get(resolvedDepPath)!;

    funcSet.add(item.funcname);
  }

  // Map を OutboundFileDependencies[] の形式に変換
  return Array.from(resultMap.entries()).map(([filepath, depMap]) => {
    const dependence = Array.from(depMap.entries()).map(([dep_filepath, funcSet]) => ({
      dep_filepath,
      // Set をソート済み配列に変換
      functions: Array.from(funcSet).sort(),
    }));
    return { filepath, dependence };
  });
}