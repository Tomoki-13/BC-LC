import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import { subpathBindings, subpathDirBindings } from '../patternRegex';
import { metaOf } from './shared';

// module-removed: 消えたサブモジュール(lib/subpath)の import を binding のみで検出
// ディレクトリごと消えた（goneDir）ときは配下すべてへの import も検出
export const convertModuleRemoved: TagConverter = (input) => {
  const meta = metaOf(input);
  const subpath = input.preSymbol.name;
  const out: GeneratedPattern[] = [];
  for (const binding of subpathBindings(meta.libName, subpath)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call] });
  }
  if (input.candidate.goneDir) {
    for (const binding of subpathDirBindings(meta.libName, input.candidate.goneDir)) {
      out.push({ ...meta, importForm: `${binding.form}:${input.candidate.goneDir}/*`, calls: [binding.call] });
    }
  }
  return out;
};
