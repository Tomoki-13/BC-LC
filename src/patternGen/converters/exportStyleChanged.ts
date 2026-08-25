import type { TagConverter } from '../../types/patternTypes';
import { usageCallPatterns } from './shared';

// export-style-changed: 公開形/accessPath が変わった API の呼び出しを検出
// 旧呼び出し形に絞れないため呼び出しを広く見る（semantic）
export const convertExportStyleChanged: TagConverter = usageCallPatterns;
