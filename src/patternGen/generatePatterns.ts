import type { ApiSurface, ApiSymbol, LossCandidate } from '../types/LibDiff';
import { LOSS_TAGS } from '../types/LibDiff';
import type { GeneratedPattern, GenerateResult, SkippedCandidate } from '../types/patternTypes';
import { CONVERTERS } from './registry';

/** 候補の symbol 名(+filePath)に対応する pre 側 ApiSymbol を引く。無ければ候補情報から最小シンボルを作る */
function resolveSymbol(candidate: LossCandidate, surface: ApiSurface | undefined): ApiSymbol {
  const byExact = surface?.symbols.find(s => s.name === candidate.symbol && s.filePath === candidate.filePath);
  const byName = byExact ?? surface?.symbols.find(s => s.name === candidate.symbol);
  if (byName) return byName;
  return { name: candidate.symbol, kind: 'unknown', exportStyle: 'unknown', filePath: candidate.filePath };
}

/**
 * 損失候補群を R-BC 形式の検出パターンへ変換する（patternGen の統括）
 *   入力: candidates（diffSurface の出力）/ preSurface / postSurface / 出力: {patterns, skipped}
 *   各候補の tag を registry で変換器に振り分け、pre/post のシンボルを解決して渡す
 */
export function generatePatterns(
  candidates: LossCandidate[],
  preSurface: ApiSurface | undefined,
  postSurface: ApiSurface | undefined,
): GenerateResult {
  const patterns: GeneratedPattern[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const candidate of candidates) {
    // LOOK: 損失タグ(LOSS_TAGS)だけをパターン化。他タグは記録用で対象外
    if (!LOSS_TAGS.has(candidate.tag)) continue;
    // 担当の関数を用意
    const converter = CONVERTERS[candidate.tag];
    const preSymbol = resolveSymbol(candidate, preSurface);
    const postSymbol = postSurface?.symbols.find(s => s.name === candidate.symbol);
    const produced = converter ? converter({ candidate, preSymbol, postSymbol }) : [];
    if (produced.length === 0) {
      skipped.push({ tag: candidate.tag, symbol: candidate.symbol });
      // NOTE: パターンが1件も出なかった候補は skipped に回し，generatePatterns の呼び出し元でログに出す
      console.debug(`generatePatterns: skipped ${candidate.tag} ${candidate.symbol} (no pattern produced)`);
      continue;
    }
    patterns.push(...produced);
  }
  return { patterns, skipped };
}
