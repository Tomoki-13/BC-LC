import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns } from './shared';

// return-changed: 返り値/仕様が変わった関数の呼び出しを検出
// 返り値の利用有無は regex で見えないため呼び出しを広く見る（semantic・FP 高め）
export const convertReturnChanged: TagConverter = usageCallPatterns;
