import type { ApiSurface, ApiSymbol, LossCandidate, ChangeTag, Confidence } from '../types/LibDiff';

/** どんな後方互換性の損失かを表すラベル（結果を見て損失内容が分かるように） */
function labelOf(tag: ChangeTag): string {
  switch (tag) {
    case 'function-removed':     return 'export 関数の削除（呼び出し不可）';
    case 'module-removed':       return 'モジュールの削除';
    case 'arg-added':            return '引数の増加（必須化なら呼び出し側で不足）';
    case 'arg-removed':          return '引数の削除（余剰引数になる）';
    case 'arg-reordered':        return '引数の並び/名称変更';
    case 'arg-type-changed':     return '引数の型変更';
    case 'return-changed':       return '返り値・仕様の変更（同一シグネチャ）';
    case 'spec-changed':         return '仕様変更';
    case 'new-required':         return 'new 必須化/禁止化';
    case 'sync-to-async':        return '同期→非同期の変化（await 要否が変わる）';
    case 'export-style-changed': return '呼び出し形/公開形式の変更（プロパティ経由など）';
    case 'module-format-changed':return 'モジュール形式の変更（CJS/ESM）';
    case 'deep-import-broken':   return '内部パス移動（deep import 破壊）';
    case 'engines-changed':      return '実行環境要求の変更（engines）';
    case 'dependency-changed':   return '依存の変更';
    case 'rename':               return 'リネーム';
    default:                     return String(tag);
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

/** 引数配列の差から arg 系タグを判定（型なし＝arity と名称ベース） */
function diffParams(pre: string[], post: string[]): ChangeTag | null {
  if (post.length > pre.length) return 'arg-added';
  if (post.length < pre.length) return 'arg-removed';
  if (pre.some((p, i) => p !== post[i])) return 'arg-reordered';
  return null;
}

function diffSurface(pre: ApiSurface, post: ApiSurface, libName: string): LossCandidate[] {
  const out: LossCandidate[] = [];
  const preByName = indexByName(pre);
  const postByName = indexByName(post);

  const make = (
    sym: ApiSymbol, tag: ChangeTag, confidence: Confidence, detail?: string
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

  for (const [name, preSyms] of preByName) {
    const postSyms = postByName.get(name);

    // 1) 削除（post に同名 export 無し）
    if (!postSyms) {
      out.push(make(preSyms[0], 'function-removed', 'structural'));
      continue;
    }

    // 2) ファイル移動（pre/post で出現ファイルが総入れ替え）→ deep-import 影響
    const preFiles = new Set(preSyms.map(s => s.filePath));
    const postFiles = new Set(postSyms.map(s => s.filePath));
    if (![...preFiles].some(f => postFiles.has(f))) {
      out.push(make(postSyms[0], 'deep-import-broken', 'structural',
        `${preSyms[0].filePath} → ${postSyms[0].filePath}`));
    }

    // 3) 同一ファイルの post を優先して対応付け、各種シグネチャ変化を検出
    const seen = new Set<string>();
    const once = (key: string, fn: () => void) => { if (!seen.has(key)) { seen.add(key); fn(); } };
    for (const a of preSyms) {
      const b = postSyms.find(s => s.filePath === a.filePath) ?? postSyms[0];

      // 3a) 引数（増減/並び）。同一なら 3b 返り値（仕様変更）を semantic で拾う
      const paramTag = diffParams(a.params ?? [], b.params ?? []);
      if (paramTag) {
        once(`${a.filePath}:${paramTag}`, () => out.push(make(b, paramTag,
          paramTag === 'arg-reordered' ? 'semantic' : 'structural',
          `(${(a.params ?? []).join(', ')}) → (${(b.params ?? []).join(', ')})`)));
      } else {
        const ra = (a.returnExprs ?? []).join(' || ');
        const rb = (b.returnExprs ?? []).join(' || ');
        if (ra !== rb && (ra || rb)) {
          once(`${a.filePath}:return-changed`, () => out.push(make(b, 'return-changed', 'semantic',
            `return: [${ra}] → [${rb}]`)));
        }
      }

      // 3c) 同期/非同期の変化（await 要否が変わる＝呼び出し側に影響）
      if ((a.isAsync ?? false) !== (b.isAsync ?? false)) {
        once(`${a.filePath}:sync-to-async`, () => out.push(make(b, 'sync-to-async', 'structural',
          `${a.isAsync ? 'async' : 'sync'} → ${b.isAsync ? 'async' : 'sync'}`)));
      }

      // 3d) 呼び出し形（プロパティ公開パス）の変化。例 uuid.v4 で呼べるか等
      //     ※ identifier 代入によるプロパティ公開（uuid.v4 = v4）は getFunction 未捕捉のため
      //       現状は object-export 形式が中心。完全対応は export 抽出拡張後（TODO）
      if ((a.accessPath ?? '') !== (b.accessPath ?? '')) {
        once(`${a.filePath}:export-style-changed`, () => out.push(make(b, 'export-style-changed', 'semantic',
          `${a.accessPath || '(直接)'} → ${b.accessPath || '(直接)'}`)));
      }
    }
  }

  return out;
}

export default {
  diffSurface,
};
