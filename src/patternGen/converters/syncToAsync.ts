import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns } from './shared';

// sync-to-async: 同期/非同期が変わった関数の呼び出しを検出
// await 有無は regex で狙えないため呼び出しを広く見る（semantic）
export const convertSyncToAsync: TagConverter = usageCallPatterns;
