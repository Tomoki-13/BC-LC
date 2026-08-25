import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import { objectBindings } from '../patternRegex';
import { metaOf } from './shared';

// module-format-changed: CJS/ESM 変化で壊れる import を binding のみで検出
// 方向は detail から判定（commonjs→module は require 側、逆は esm import 側）
export const convertModuleFormatChanged: TagConverter = (input) => {
  const meta = metaOf(input);
  const toEsm = /commonjs\s*→\s*module/.test(input.candidate.detail ?? '');
  const out: GeneratedPattern[] = [];
  for (const binding of objectBindings(meta.libName)) {
    const isRequire = binding.form === 'cjs-require';
    if (toEsm ? isRequire : !isRequire) {
      out.push({ ...meta, importForm: binding.form, calls: [binding.call] });
    }
  }
  return out;
};
