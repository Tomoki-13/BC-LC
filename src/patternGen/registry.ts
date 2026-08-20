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
import { convertNewRequired } from './converters/newRequired';
import { convertExportStyleChanged } from './converters/exportStyleChanged';
import { convertOptionRemoved } from './converters/optionRemoved';
import { convertModuleFormatChanged } from './converters/moduleFormatChanged';
import { convertNodeNpmRequirementRaised } from './converters/nodeNpmRequirementRaised';

/**
 * ChangeTag → パターン変換器の対応表（LOSS_TAGS を全て登録）
 *   非損失タグ（arg-added / option-added 等）は generatePatterns 側で LOSS_TAGS フィルタにより到達しない
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
  'new-required': convertNewRequired,
  'export-style-changed': convertExportStyleChanged,
  'option-removed': convertOptionRemoved,
  'module-format-changed': convertModuleFormatChanged,
  'node-npm-requirement-raised': convertNodeNpmRequirementRaised,
};
