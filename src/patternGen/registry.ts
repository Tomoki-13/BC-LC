import type { ChangeTag } from '../types/LibDiff';
import type { TagConverter } from '../types/patternTypes';
import { convertFunctionRemoved } from './converters/functionRemoved';
import { convertExportRemoved } from './converters/exportRemoved';
import { convertModuleRemoved } from './converters/moduleRemoved';
import { convertDeepImportBroken } from './converters/deepImportBroken';
import { convertArgReordered } from './converters/argReordered';
import { convertArgRemoved } from './converters/argRemoved';
import { convertSyncToAsync } from './converters/syncToAsync';
import { convertReturnChanged } from './converters/returnChanged';

/**
 * ChangeTag → パターン変換器の対応表（検証済みタグのみ登録）
 *   未登録のタグは generatePatterns 側で「パターン無し」として skipped に回す
 */
export const CONVERTERS: Partial<Record<ChangeTag, TagConverter>> = {
  'function-removed': convertFunctionRemoved,
  'export-removed': convertExportRemoved,
  'module-removed': convertModuleRemoved,
  'deep-import-broken': convertDeepImportBroken,
  'arg-reordered': convertArgReordered,
  'arg-removed': convertArgRemoved,
  'sync-to-async': convertSyncToAsync,
  'return-changed': convertReturnChanged,
};
