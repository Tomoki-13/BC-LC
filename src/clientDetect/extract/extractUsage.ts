// クライアント repo のライブラリ使用（import＋呼び出し）を抽出し、照合用に整形する（repo×lib でキャッシュ）。
import { useAst } from './useAst';
import { listClientFilePaths } from './clientSource';
import type { ExtractFunctionCallsResult } from '../../types/ExtractFunctionCallsResult';

/** 抽出済みクライアント: usageByFile=ファイルごとの [import＋呼び出し]（argTypes/argContexts 付き） */
export interface ExtractedClient {
  usageByFile: ExtractFunctionCallsResult[][];  // useAst の出力（1要素=1ファイルの使用ブロック群）
}

// 同一 repo×lib は複数の版ペアで再利用されるためキャッシュ（useAst は重いので効く）
const cache = new Map<string, ExtractedClient | null>();

/** repo × libName の使用を抽出。repo が無ければ null */
export async function extractClientUsage(repoDir: string, libName: string): Promise<ExtractedClient | null> {
  const key = `${repoDir}::${libName}`;
  if (cache.has(key)) {
    return cache.get(key)!;
  }

  const paths = await listClientFilePaths(repoDir);
  if (!paths) {
    cache.set(key, null);
    return null;
  }

  let usageByFile: ExtractFunctionCallsResult[][] = [];
  try {
    usageByFile = await useAst(paths, libName, 0);
  } catch {
    usageByFile = [];
  }
  const out: ExtractedClient = { usageByFile };
  cache.set(key, out);
  return out;
}
