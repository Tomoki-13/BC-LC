import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns } from './shared';

// new-required: 関数↔class 化した API の呼び出しを検出
// new 有無は regex で狙えないため呼び出しを広く見る
export const convertNewRequired: TagConverter = usageCallPatterns;
