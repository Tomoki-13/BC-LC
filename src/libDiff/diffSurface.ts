import semver from 'semver';
import type { ApiSurface, ApiSymbol, LossCandidate, ChangeTag, Confidence } from '../types/LibDiff';

// semver でない range（github:/file:/workspace: 等）で throw させず null を返す
const safeMinVersion = (range: string) => { try { return semver.minVersion(range); } catch { return null; } };

/** どんな後方互換性の損失かを表すラベル（結果を見て損失内容が分かるように） */
function labelOf(tag: ChangeTag): string {
  switch (tag) {
    case 'function-removed':            return 'export 関数の削除（呼び出し不可）';
    case 'export-removed':              return '非関数 export（変数/値/メンバ）の削除（参照不可）';
    case 'module-removed':              return 'モジュールの削除';
    case 'arg-added':                   return '引数の増加（必須化なら呼び出し側で不足）';
    case 'arg-removed':                 return '引数の削除（余剰引数になる）';
    case 'arg-reordered':               return '引数の並び替え（位置がずれる＝破壊的）';
    case 'arg-type-changed':            return '引数の型変更';
    case 'option-removed':              return 'options キーの削除（クライアントの指定が無視される）';
    case 'option-added':                return 'options キーの追加（加算的・参考）';
    case 'return-changed':              return '返り値・仕様の変更（同一シグネチャ）';
    case 'spec-changed':                return '仕様変更';
    case 'new-required':                return 'new 必須化/禁止化';
    case 'sync-to-async':               return '同期→非同期の変化（await 要否が変わる）';
    case 'export-style-changed':        return '呼び出し形/公開形式の変更（プロパティ経由など）';
    case 'module-format-changed':       return 'モジュール形式の変更（CJS/ESM）';
    case 'deep-import-broken':          return '内部パス移動（deep import 破壊）';
    case 'node-npm-requirement-raised': return 'node/npm の必要バージョン引き上げ（engines・それ未満の利用者が install/実行不可）';
    case 'dependency-changed':          return '依存の変更';
    default:                            return String(tag);
  }
}

/** export 名 → シンボル群（同名が複数ファイルに出ることもある） */
function indexByName(surface: ApiSurface): Map<string, ApiSymbol[]> {
  const m = new Map<string, ApiSymbol[]>();
  for (const s of surface.symbols) {
    const arr = m.get(s.name);
    if (arr) arr.push(s);
    else m.set(s.name, [s]);
  }
  return m;
}

/** 引数配列の差から arg 系タグを判定（型なし＝arity と名称ベース）
 *  - 個数変化 → arg-added / arg-removed
 *  - 同数で「同じ名前集合の並び替え」→ arg-reordered（位置がずれるので破壊的）
 *  - 同数で「名前集合が違う」＝単なるリネーム → null（位置引数呼び出しは壊れないので除外＝ノイズ低減） */
function diffParams(pre: string[], post: string[]): ChangeTag | null {
  if (post.length > pre.length) return 'arg-added';
  if (post.length < pre.length) return 'arg-removed';
  if (pre.every((p, i) => p === post[i])) return null;
  const sameSet = JSON.stringify([...pre].sort()) === JSON.stringify([...post].sort());
  return sameSet ? 'arg-reordered' : null;
}

/** 返り値式の比較用に空白を正規化（整形だけの差を無視する） */
function normReturns(arr: string[] | undefined): string {
  return (arr ?? []).join(' || ').replace(/\s+/g, ' ').trim();
}

/**
 * engines(node/npm) の必要下限が pre→post で引き上げられたか判定する
 *   入力: field=対象(node|npm) / preRange・postRange=各版の engines range 文字列（例 ">=12"。宣言なしは undefined）
 *   出力: 引き上げ・新規付与のときは変化を説明する文字列(detail)、それ以外（同じ/下がった/撤廃）は null
 */
function raisedEngineFloor(field: 'node' | 'npm', preRange?: string, postRange?: string): string | null {
  if (!postRange) return null;                       // post に要求なし → 制約なし/緩和
  const postMin = safeMinVersion(postRange);
  if (!postMin) return null;                         // range として解釈不能（semver でない等）
  if (!preRange) {
    // pre に要求なし → 新規に下限追加（"*"/">=0" 等の実質無制限は除外）
    return semver.gt(postMin, '0.0.0')
      ? `engines.${field}: (なし) → ${postRange}（新規に ${postMin.version} 以上を要求）`
      : null;
  }
  const preMin = safeMinVersion(preRange);
  if (preMin && semver.gt(postMin, preMin)) {
    return `engines.${field}: ${preRange} → ${postRange}（下限 ${preMin.version} → ${postMin.version}）`;
  }
  return null;
}

/** pre/post の surface を突き合わせ、後方互換性の損失候補を返す */
function diffSurface(pre: ApiSurface, post: ApiSurface, libName: string): LossCandidate[] {
  const out: LossCandidate[] = [];
  const preByName = indexByName(pre);
  const postByName = indexByName(post);

  const make = (
    sym: ApiSymbol, tag: ChangeTag, confidence: Confidence, detail?: string,
  ): LossCandidate => ({
    libName,
    preVersion: pre.version,
    postVersion: post.version,
    symbol: sym.name,
    filePath: sym.filePath,
    tag,
    label: labelOf(tag),
    confidence,
    detail,
  });

  // pre の全 export 名 × 全定義(ファイル)を走査
  for (const [name, preSyms] of preByName) {
    const postSyms = postByName.get(name) ?? [];
    const preFiles = new Set(preSyms.map(s => s.filePath));
    const postFiles = new Set(postSyms.map(s => s.filePath));
    // 名前は残るが pre/post でファイルが全く重ならない＝定義の移動（deep-import 破壊）
    const relocated = postSyms.length > 0 && ![...preFiles].some(f => postFiles.has(f));

    const seen = new Set<string>();
    const once = (key: string, fn: () => void) => { if (!seen.has(key)) { seen.add(key); fn(); } };

    // 定義=ファイル単位で対応付け（同名が複数ファイルにあっても全て評価）
    for (const a of preSyms) {
      let b = postSyms.find(s => s.filePath === a.filePath);
      // 削除タグは種別で出し分け（関数=function-removed / 非関数 export=export-removed）
      const removedTag: ChangeTag = a.kind === 'value' ? 'export-removed' : 'function-removed';

      // 1) 対応する post 定義が無い → 削除 / 移動 を定義(ファイル)単位で判定
      if (!b) {
        // 1a) 名前ごと消滅（複数ファイルにあれば各ファイル分を記録）
        if (postSyms.length === 0) {
          once(`${a.filePath}:${removedTag}`, () => out.push(make(a, removedTag, 'structural')));
          continue;
        }
        // 1b) 全ファイル移動 → deep-import 破壊。移動先を対応先にして署名比較も継続
        if (relocated) {
          once(`${a.filePath}:deep-import-broken`, () => out.push(make(a, 'deep-import-broken', 'structural',
            `${a.filePath} → ${postSyms[0].filePath}`)));
          b = postSyms[0];
        } else {
          // 1c) 名前は他ファイルに残るが この定義(ファイル)は消えた（このパスの deep import が壊れる）
          once(`${a.filePath}:${removedTag}`, () => out.push(make(a, removedTag, 'structural',
            `${a.filePath} から削除（他ファイルには存在）`)));
          continue;
        }
      }

      // 2) 署名変化を検出（arg と return は排他にしない＝取りこぼし防止）
      // 2a) 引数（増減/並び）
      const paramTag = diffParams(a.params ?? [], b.params ?? []);
      if (paramTag) {
        once(`${a.filePath}:${paramTag}`, () => out.push(make(b, paramTag, 'structural',
          `(${(a.params ?? []).join(', ')}) → (${(b.params ?? []).join(', ')})`)));
      }

      // 2b) 返り値（整形だけの差＝関数↔アロー等の一部ノイズは空白正規化で無視）
      const ra = normReturns(a.returnExprs);
      const rb = normReturns(b.returnExprs);
      if (ra !== rb && (ra || rb)) {
        once(`${a.filePath}:return-changed`, () => out.push(make(b, 'return-changed', 'semantic',
          `return: [${ra}] → [${rb}]`)));
      }

      // 2c) 同期/非同期の変化（await 要否が変わる＝呼び出し側に影響）
      if ((a.isAsync ?? false) !== (b.isAsync ?? false)) {
        once(`${a.filePath}:sync-to-async`, () => out.push(make(b, 'sync-to-async', 'structural',
          `${a.isAsync ? 'async' : 'sync'} → ${b.isAsync ? 'async' : 'sync'}`)));
      }

      // 2d) 呼び出し形（プロパティ公開パス accessPath）の変化。例: uuid.v4 → 直接
      if ((a.accessPath ?? '') !== (b.accessPath ?? '')) {
        once(`${a.filePath}:export-style-changed`, () => out.push(make(b, 'export-style-changed', 'semantic',
          `${a.accessPath || '(直接)'} → ${b.accessPath || '(直接)'}`)));
      }

      // 2e) options オブジェクトの受理キー変化（分割代入 or opts.key 読み取りベース）
      const preKeys = new Set(a.optionKeys ?? []);
      const postKeys = new Set(b.optionKeys ?? []);
      if (preKeys.size > 0) {
        // 追加(option-added)は加算的で非破壊のため損失候補にしない。削除のみ BC 損失として出す
        const removed = [...preKeys].filter(k => !postKeys.has(k));
        if (removed.length > 0) {
          once(`${a.filePath}:option-removed`, () => out.push(make(b, 'option-removed', 'semantic',
            `削除キー: ${removed.join(', ')}`)));
        }
      }
    }
  }

  // engines(node/npm) の必要下限引き上げ＝それ未満のランタイム利用者が install/実行で壊れる（symbol 非依存）
  for (const field of ['node', 'npm'] as const) {
    const detail = raisedEngineFloor(field, pre.engines?.[field], post.engines?.[field]);
    if (detail) {
      out.push({
        libName,
        preVersion: pre.version,
        postVersion: post.version,
        symbol: `engines.${field}`,   // 関数ではないので symbol 欄には対象名 engines.node / engines.npm を入れる
        filePath: 'package.json',      // 検出元は package.json（ソースファイルではない）
        tag: 'node-npm-requirement-raised',
        label: labelOf('node-npm-requirement-raised'),
        confidence: 'structural',      // package.json の確定事実なので構造的（確実）
        detail,                        // 例 "engines.node: >=8 → >=10（下限 8.0.0 → 10.0.0）"
      });
    }
  }

  return out;
}

export default {
  diffSurface,
};
