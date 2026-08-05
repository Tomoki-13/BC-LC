import type { ConverterInput, GeneratedPattern } from '../patternTypes';
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

/**
 * その関数を「呼び出している」クライアントを検出するパターン群（署名/挙動が変わったが関数は残るタグ共通）
 *   関数は存在するので参照でなく呼び出しを見る
 *   (A) default が関数/クラス: variable1(...) / new variable1(...) / variable1.default(...)(interop)
 *   (B) 名前付き/プロパティ関数: variable1.NAME(...) / NAME(...) / 別名は捕捉変数 v1(...)
 */
export function usageCallPatterns(input: ConverterInput): GeneratedPattern[] {
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
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, memberCall(name)] });
  }
  for (const binding of namedBindings(meta.libName, name)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, namedCall(name)] });
  }
  for (const binding of namedAliasBindings(meta.libName, name)) {
    out.push({ ...meta, importForm: binding.form, calls: [binding.call, directCall()] });
  }
  return out;
}
