import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns } from './shared';

/**
 * arg-removed: 引数が減った関数を呼び出しているクライアントを検出
 *   中間の引数削除は位置引数がずれ、末尾削除も TS では excess-argument になるため、arity で絞らず呼び出しを広く検出
 *   関数は残るので参照でなく呼び出しを見る
 */
export const convertArgRemoved: TagConverter = usageCallPatterns;
