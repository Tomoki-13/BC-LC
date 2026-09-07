import type { GeneratedPattern } from '../../types/patternTypes';
import type { ExtractFunctionCallsResult } from '../../types/ExtractFunctionCallsResult';
import { escapeFunc, bindingVarKey } from './patternToScript';

/** client 1件（useAst 抽出）に対する照合結果 */
export interface ClientMatch {
  matched: boolean;
  hits: { pattern: GeneratedPattern; file: string }[]; // 命中パターンと命中ファイル
}

interface FlatBlock { code: string; types: string[][]; context: string[][] }

// 照合前の正規化: 改行除去＋ [...]/{...} を argument に潰す（usage 正規表現がネスト内のカンマ等で誤爆しないように）
function normalizeForRegex(code: string): string {
  return code.replace(/[\r\n]/g, '').replace(/\[[^\]]*\]/g, 'argument').replace(/\{[^}]*\}/g, 'argument');
}

// usage 正規表現が当たった後の妥当性チェック（型を持たない生成パターン向け＝現状の主判定）
//   argCheck: 呼び出しの引数個数 argTypes.length ≥ minArgs
//   removedKey: 削除キー名が 生コード or argContexts(解決値) に出現
function usageValid(pattern: GeneratedPattern, block: FlatBlock): boolean {
  if (pattern.argCheck && block.types.length < pattern.argCheck.minArgs) return false;
  if (pattern.removedKey) {
    const key = pattern.removedKey;
    const inCode = new RegExp(`\\b${key}\\b`).test(block.code);
    const inContext = block.context.some(perArg => perArg.some(snip => new RegExp(`\\b${key}\\b`).test(snip)));
    if (!inCode && !inContext) return false;
  }
  return true;
}

// "object:{key1,key2}" 形式からキー名配列を取り出す
function extractObjectTypeKeys(type: string): string[] {
  const m = type.match(/^object:\{(.*)\}$/);
  return m && m[1] ? m[1].split(',').filter(k => k.length > 0) : [];
}

// 2つの型文字列がマッチするか（完全一致／旧形式 'object' 後方互換／object:{key} のキー部分一致）
function isTypeMatch(patternType: string, targetType: string): boolean {
  if (patternType === targetType) return true;
  if (patternType === 'object' && targetType.startsWith('object')) return true;
  if (targetType === 'object' && patternType.startsWith('object')) return true;
  if (patternType.startsWith('object:{') && targetType.startsWith('object:{')) {
    const pk = extractObjectTypeKeys(patternType), tk = extractObjectTypeKeys(targetType);
    return pk.every(k => tk.includes(k));
  }
  return false;
}

// 型集合の比較（将来用・現状は生成パターンに型が無いので自動スキップ）
//   将来ライブラリ側で引数型を静的予測し、client 側の argTypes（useAst 抽出）と突き合わせる時に有効化する。
//   mode 0: 型を見ない / 1: object をキー無視で集合一致 / 2: object:{key} のキー部分一致（isTypeMatch）
//   expectedTypes（パターン側）が空なら型比較しない＝型を持たない今の生成パターンでは常に true。
//   unknown は除外して比較し、どちらかが空になった引数位置はスキップ（解析不十分な位置で落とさない）。
function typesCompatible(expectedTypes: string[][], userTypes: string[][], mode: number): boolean {
  if (mode < 1) return true;
  if (expectedTypes.length === 0) return true; // パターン側に型が無い（現状）＝型比較しない
  if (userTypes.length !== expectedTypes.length) return false; // 型ありモードでは個数厳密一致
  for (let k = 0; k < expectedTypes.length; k++) {
    const fe = expectedTypes[k].filter(t => t !== 'unknown');
    const fu = userTypes[k].filter(t => t !== 'unknown');
    if (fe.length === 0 || fu.length === 0) continue; // どちらか型不明＝この位置はスキップ
    if (mode >= 2) {
      if (!fe.every(et => fu.some(ut => isTypeMatch(et, ut)))) return false;
    } else {
      const norm = (t: string) => t.startsWith('object') ? 'object' : t;
      if (fu.map(norm).sort().join(',') !== fe.map(norm).sort().join(',')) return false;
    }
  }
  return true;
}

/** 1パターンが client(抽出済み groups) に命中するか。命中ファイルを返す（無ければ null）
 * binding→usage の2段照合。calls[0]=binding で実変数名を捕捉し、calls[1..]=usage に差し込んで照合する
 * （パターンは変数1つ variable1 か、変数なし＝binding のみ）
 * 妥当性は usageValid（個数/キー・型なしパターン向け）＋ typesCompatible（型ありパターン向け・将来用）の両方 */
function matchOne(pattern: GeneratedPattern, groups: ExtractFunctionCallsResult[][], mode: number): string | null {
  const binding = pattern.calls[0];
  if (!binding) return null;
  const usages = pattern.calls.slice(1);
  const key = bindingVarKey(binding.FunctionCallCode); // (?<variableN>) を持たない binding（esm-named 等）は null

  let bindingSrc = escapeFunc(binding.FunctionCallCode);
  if (key && !bindingSrc.includes(`(?<${key}>`)) bindingSrc = bindingSrc.replace(new RegExp(key, 'g'), `(?<${key}>[\\w$]+)`);
  let bindingRe: RegExp; try { bindingRe = new RegExp(bindingSrc); } catch { return null; }

  for (const group of groups) {
    const flat: FlatBlock[] = group.map(b => ({ code: b.FunctionCallCode, types: b.argTypes ?? [], context: b.argContexts ?? [] }));

    // binding を満たす行を探す（見つかった位置以降で usage を照合）
    for (let i = 0; i < flat.length; i++) {
      const m = flat[i].code.match(bindingRe);
      if (!m) continue;
      const actualVar = key ? m.groups?.[key] : undefined;
      if (key && !actualVar) continue; // 変数捕捉が要るのに取れなければ次の binding 候補へ

      if (usages.length === 0) return group[i].filePath ?? '(matched)'; // binding のみ＝import 成立で命中

      let allMatched = true;
      for (const usage of usages) {
        const uCode = key && actualVar ? usage.FunctionCallCode.split(key).join(actualVar) : usage.FunctionCallCode;
        let usageRe: RegExp; try { usageRe = new RegExp(escapeFunc(uCode)); } catch { allMatched = false; break; }
        const expectedTypes = usage.argTypes ?? []; // パターン側の引数型（将来ライブラリから予測して入れる想定・現状は空）
        let matched = false;
        for (let j = i + 1; j < flat.length; j++) {
          if (usageRe.test(normalizeForRegex(flat[j].code))
            && usageValid(pattern, flat[j])
            && typesCompatible(expectedTypes, flat[j].types, mode)) { matched = true; break; }
        }
        if (!matched) { allMatched = false; break; }
      }
      if (allMatched) return group[i].filePath ?? '(matched)';
    }
  }
  return null;
}

/** client(抽出済み groups) に全パターンを照合し、命中を列挙する
 * mode: 型比較の強さ（0=型を見ない / 1=object キー無視で集合一致 / 2=object:{key} キー部分一致）。
 *   現状の生成パターンは型を持たないため mode に関わらず型比較はスキップされる（arity/key で判定）。
 *   将来ライブラリ側で引数型を予測して argTypes に入れたら mode で型考慮を有効化できる。 */
export function typeAwarePatternMatch(
  patterns: GeneratedPattern[],
  groups: ExtractFunctionCallsResult[][],
  mode: number = 2,
): ClientMatch {
  const hits: { pattern: GeneratedPattern; file: string }[] = [];
  for (const p of patterns) {
    const file = matchOne(p, groups, mode);
    if (file !== null) hits.push({ pattern: p, file });
  }
  return { matched: hits.length > 0, hits };
}
