import type { TagConverter } from '../../types/patternTypes';
import { anyRootImportBindings } from '../patternRegex';
import { metaOf } from './shared';

// published-file-missing: ライブラリ本体を読み込むだけで Cannot find module になるため、本体の import/require を binding のみで検出
export const convertPublishedFileMissing: TagConverter = (input) => {
  const meta = metaOf(input);
  return anyRootImportBindings(meta.libName).map(binding => ({ ...meta, importForm: binding.form, calls: [binding.call] }));
};
