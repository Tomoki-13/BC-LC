import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import { subpathBindings } from '../patternRegex';
import { metaOf } from './shared';

// module-removed: 消えたサブモジュール(lib/subpath)の import を binding のみで検出
export const convertModuleRemoved: TagConverter = (input) => {
  const meta = metaOf(input);
  const subpath = input.preSymbol.name;
  const out: GeneratedPattern[] = [];
  for (const binding of subpathBindings(meta.libName, subpath)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call] });
  }
  return out;
};
