import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import { objectBindings, directCall, newCall, capturedReference } from '../patternRegex';
import { metaOf } from './shared';

// entry-default-removed: 入口ファイルの default が無くなったときの使用を検出
//   post の入口が ESM: import x from 'lib' の x は undefined になるので x の参照すべて（例 uuid 7.0.0 で import uuid from 'uuid'; uuid.v4()）
//   それ以外の記法・CJS の入口: default を関数・クラスとして呼ぶ形（x() / new x()）
//   pre の default が値（kind: value）でも作る。値と読まれる default には関数を返す式（module.exports = (function () { … }())）があり、呼べない値ならクライアントは呼ばない
//   import * as x の x() / new x() も含める（TypeScript で esModuleInterop なしなら require と同じ）
export const convertEntryDefaultRemoved: TagConverter = (input) => {
  const meta = metaOf(input);
  const { candidate } = input;
  const out: GeneratedPattern[] = [];
  for (const binding of objectBindings(meta.libName)) {
    if (candidate.entryEsm && binding.form === 'esm-default') {
      out.push({ ...meta, importForm: binding.form, calls: [binding.call, capturedReference()] });
      continue;
    }
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, directCall()] });
    out.push({ ...meta, importForm: `${binding.form}#new`, calls: [binding.call, newCall()] });
  }
  return out;
};
