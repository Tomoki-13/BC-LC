import type { ConverterInput, GeneratedPattern } from '../../types/patternTypes';
import {
  objectBindings, namedBindings, namedAliasBindings,
  memberCall, namedCall, directCall, newCall, interopDefaultCall,
} from '../patternRegex';

/** 候補から GeneratedPattern の共通メタを作る（tag/label/confidence は候補＝diffSurface の判定をそのまま使う） */
export function metaOf({ candidate, preSymbol }: ConverterInput): Omit<GeneratedPattern, 'importForm' | 'calls'> {
  return {
    libName: candidate.libName,
    preVersion: candidate.preVersion,
    postVersion: candidate.postVersion,
    symbol: preSymbol.name,
    tag: candidate.tag,
    label: candidate.label,
    confidence: candidate.confidence,
  };
}

// pre/post 引数列が最初に食い違う位置（0基点）を返す。arg-removed/arg-reordered の最低引数個数の算出に使う
// 例 (a,b,c)→(a,c): index1 で相違 / (a,b)→(): index0 / 相違なしは pre 長を返す
export function firstArgDivergence(pre: string[], post: string[]): number {
  let i = 0;
  while (i < post.length && pre[i] === post[i]) i++;
  return i;
}

// 関数は残るが署名/挙動が変わったタグ共通: その関数の「呼び出し」を検出するパターン群
// default は直呼び/new/interop、名前付きは member/named/別名の各呼び出し
// minArgs: 最低引数個数（arg-removed/arg-reordered が影響位置から渡す。既定0＝数不問）
export function usageCallPatterns(input: ConverterInput, minArgs = 0): GeneratedPattern[] {
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
      out.push({ ...meta, importForm: binding.form, calls: [binding.call, directCall(minArgs)] });
      out.push({ ...meta, importForm: `${binding.form}#new`, calls: [binding.call, newCall(minArgs)] });
    }
    const requireBinding = objectBindings(meta.libName).find(b => b.form === 'cjs-require')!;
    out.push({ ...meta, importForm: 'cjs-require#interop-default', calls: [requireBinding.call, interopDefaultCall(minArgs)] });
    return out;
  }

  for (const binding of objectBindings(meta.libName)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, memberCall(name, minArgs)] });
  }
  for (const binding of namedBindings(meta.libName, name)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, namedCall(name, minArgs)] });
  }
  for (const binding of namedAliasBindings(meta.libName, name)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, directCall(minArgs)] });
  }
  return out;
}
