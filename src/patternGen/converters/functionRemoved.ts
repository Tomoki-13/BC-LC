import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import {
  objectBindings, namedBindings, namedAliasBindings,
  memberReference, directCall, newCall, interopDefaultCall,
} from '../patternRegex';
import { metaOf } from './shared';

// function-removed: 消えた export 関数の使用を検出
// default は直呼び/new/interop、名前付きは named import なら binding のみ・object 経由は member 参照
export const convertFunctionRemoved: TagConverter = (input) => {
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
      out.push({ ...meta, importForm: binding.form, calls: [binding.call, directCall()] });
      out.push({ ...meta, importForm: `${binding.form}#new`, calls: [binding.call, newCall()] });
    }
    const requireBinding = objectBindings(meta.libName).find(b => b.form === 'cjs-require')!;
    out.push({ ...meta, importForm: 'cjs-require#interop-default', calls: [requireBinding.call, interopDefaultCall()] });
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
