import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import { objectBindings, namedBindings, memberCall, namedCall } from '../patternRegex';
import { metaOf } from './shared';

// candidate.detail "削除キー: a, b" から削除キーを取る（optionKeys 差が取れない時のフォールバック）
function keysFromDetail(detail: string | undefined): string[] {
  const m = /削除キー:\s*(.+)$/.exec(detail ?? '');
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

// option-removed: 削除された options キーを渡す呼び出しを検出（キーごとに1組）
// キーは regex に焼かず removedKey に持たせ、照合時に client の argContexts/コードにキー名が出現するかで判定
// 削除キー = pre/post の optionKeys 差、無ければ detail からフォールバック
export const convertOptionRemoved: TagConverter = (input) => {
  const { candidate, preSymbol, postSymbol } = input;
  const postKeys = new Set(postSymbol?.optionKeys ?? []);
  const diffKeys = (preSymbol.optionKeys ?? []).filter(k => !postKeys.has(k));
  const removedKeys = diffKeys.length > 0 ? diffKeys : keysFromDetail(candidate.detail);
  const meta = metaOf(input);
  const name = preSymbol.name;

  const out: GeneratedPattern[] = [];
  for (const key of removedKeys) {
    for (const binding of objectBindings(meta.libName)) {
      out.push({ ...meta, importForm: `${binding.form}#${key}`, calls: [binding.call, memberCall(name)], removedKey: key });
    }
    for (const binding of namedBindings(meta.libName, name)) {
      out.push({ ...meta, importForm: `${binding.form}#${key}`, calls: [binding.call, namedCall(name)], removedKey: key });
    }
  }
  return out;
};
