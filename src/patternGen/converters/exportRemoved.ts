import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import {
  objectBindings, namedBindings, namedAliasBindings,
  memberReference, capturedReference, interopDefaultReference,
} from '../patternRegex';
import { metaOf } from './shared';

// export-removed: 消えた非関数 export の参照を検出（値は呼ばず参照）
// default は束縛参照/interop、名前付きは named import なら binding のみ・object 経由は member 参照
export const convertExportRemoved: TagConverter = (input) => {
  const meta = metaOf(input);
  const { preSymbol } = input;
  const name = preSymbol.name;
  const isDefault = name === 'default'
    || preSymbol.exportStyle === 'esm-default'
    || preSymbol.exportStyle === 'cjs-module-default';

  const out: GeneratedPattern[] = [];

  if (isDefault) {
    for (const binding of objectBindings(meta.libName)) {
      if (binding.form === 'esm-namespace') continue;
      out.push({ ...meta, importForm: binding.form, calls: [binding.call, capturedReference()] });
    }
    const requireBinding = objectBindings(meta.libName).find(b => b.form === 'cjs-require')!;
    out.push({ ...meta, importForm: 'cjs-require#interop-default', calls: [requireBinding.call, interopDefaultReference()] });
    return out;
  }

  for (const binding of objectBindings(meta.libName)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, memberReference(name)] });
  }
  for (const binding of [...namedBindings(meta.libName, name), ...namedAliasBindings(meta.libName, name)]) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call] });
  }
  return out;
};
