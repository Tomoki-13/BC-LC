import path from 'path';
import semver from 'semver';
import type { ApiSurface, ApiSymbol, LossCandidate, ChangeTag, Confidence } from '../types/LibDiff';
import { sameReturnsModuloRenaming } from './returnEquivalence';

// semver でない range（github:/file:/workspace: 等）で throw させず null を返す
const safeMinVersion = (range: string) => { try { return semver.minVersion(range); } catch { return null; } };

/** どんな後方互換性の損失かを表すラベル（結果を見て損失内容が分かるように） */
export function labelOf(tag: ChangeTag): string {
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
    case 'new-required':                return 'new 必須化/禁止化';
    case 'sync-to-async':               return '同期→非同期の変化（await 要否が変わる）';
    case 'export-style-changed':        return '呼び出し形/公開形式の変更（プロパティ経由など）';
    case 'module-format-changed':       return 'モジュール形式の変更（CJS/ESM）';
    case 'deep-import-broken':          return '内部パス移動（deep import 破壊）';
    case 'node-npm-requirement-raised': return 'node/npm の必要バージョン引き上げ（engines・それ未満の利用者が install/実行不可）';
    case 'published-file-missing':      return '公開物からのファイル欠落（読み込み時に Cannot find module）';
    case 'exports-restricted':          return 'package.json exports による公開範囲の縮小（サブパス・require が読めなくなる）';
    case 'entry-default-removed':       return '入口ファイルの default の削除（require(lib)() / import x from lib が壊れる）';
    case 'dependency-breaking-change':  return '依存パッケージの破壊的変更を呼ぶ公開関数（依存パッケージの更新で挙動・呼び出しが壊れる）';
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
 *  - 個数増加 → null（arg-added は追加が必須か任意か surface では判別できず破壊と断定できないため損失分類しない・予約タグ）
 *  - 個数減少 → arg-removed
 *  - 同数で「同じ名前集合の並び替え」→ arg-reordered（位置がずれるので破壊的）
 *  - 同数で「名前集合が違う」＝単なるリネーム → null（位置引数呼び出しは壊れないので除外＝ノイズ低減） */
function diffParams(pre: string[], post: string[]): ChangeTag | null {
  if (post.length > pre.length) return null;
  if (post.length < pre.length) return 'arg-removed';
  if (pre.every((p, i) => p === post[i])) return null;
  const sameSet = JSON.stringify([...pre].sort()) === JSON.stringify([...post].sort());
  return sameSet ? 'arg-reordered' : null;
}

/** 返り値式の比較用に空白と文字列の引用符を正規化（整形だけの差を無視する）
 *  例: typeof x === "object" と typeof x === 'object' は同じ（is-object 1.0.1→1.0.2）。中に ' を含む "…" と ${} を含む `…` はそのまま */
function normReturns(arr: string[] | undefined): string {
  return (arr ?? []).join(' || ')
    .replace(/"((?:[^"'\\\n]|\\.)*)"/g, "'$1'")
    .replace(/`((?:[^`'$\\\n]|\\.)*)`/g, "'$1'")
    .replace(/\s+/g, ' ').trim();
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

/** 返り値の式を書いたファイルの読み込み（再公開をたどった記号は定義元のファイル） */
function importsOf(surface: ApiSurface, sym: ApiSymbol): Record<string, string> {
  const file = sym.resolvedFrom ? sym.resolvedFrom.split('#')[0] : sym.filePath;
  return surface.importsByFile?.[file] ?? {};
}

/** クライアントがその記号に触れる名前（`require(lib).<名前>`）。default は別名のプロパティがあっても default */
export function publicNameOf(sym: ApiSymbol): string {
  if (sym.name === 'default' || !sym.accessPath) return sym.name;
  const parts = sym.accessPath.split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : sym.name;
}

/** 入口ファイルの記号を、クライアントから触れる名前（publicNameOf）ごとにまとめる。同じ名前が複数あれば値より関数・クラスを使う */
export function entryApis(surface: ApiSurface): Map<string, ApiSymbol> {
  const out = new Map<string, ApiSymbol>();
  for (const s of surface.symbols) {
    if (s.filePath !== surface.entryFile) continue;
    const key = publicNameOf(s);
    const prev = out.get(key);
    if (!prev || (prev.kind === 'value' && s.kind !== 'value')) out.set(key, s);
  }
  return out;
}

/** pre/post の surface を突き合わせ、後方互換性の損失候補を返す */
function diffSurface(pre: ApiSurface, post: ApiSurface, libName: string): LossCandidate[] {
  const out: LossCandidate[] = [];
  const unpublished = new Set(pre.unpublishedFiles ?? []);

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

  const seen = new Set<string>();
  const once = (key: string, fn: () => void) => { if (!seen.has(key)) { seen.add(key); fn(); } };

  // emit するタグと検出箇所:
  //   per-name: 1) function-removed / export-removed  2a) arg-added / arg-removed / arg-reordered
  //             2b) return-changed  2c) sync-to-async  2d) export-style-changed  2e) option-removed  2f) new-required
  //     入口ファイルが pre/post とも分かる（post の入口から export を1件以上取れた）ときは、入口の公開名ごとに比べる
  //     分からないときは、配られるファイルの名前×定義ファイルで比べる
  //   package.json（symbol 非依存）: 3a) node-npm-requirement-raised   3b) module-format-changed   3c) published-file-missing
  //                                 3d) exports-restricted   3e) entry-default-removed（入口ファイルの default）
  //   file-level（サブパス）:        4a) deep-import-broken（移動）      4b) module-removed（削除）

  // 2) pre の記号 a と post の記号 b の署名を比べる
  const compareSignatures = (a: ApiSymbol, b: ApiSymbol) => {
    // 署名が分からない値（kind=value）が片方にあるときは比べない
    //   例: default が関数 → `module.exports = require('./lib/x')`（値）になると、引数 [] と比べて arg-removed に見える
    if (a.kind === 'value' || b.kind === 'value') return;
    const k = `${a.name}:${a.filePath}`;

    // 2a) arg-added / arg-removed / arg-reordered: 引数の増減・並び替え
    const paramTag = diffParams(a.params ?? [], b.params ?? []);
    if (paramTag) {
      const preParams = a.params ?? [], postParams = b.params ?? [];
      // 末尾のみ削除（post が pre の接頭辞）＝ 余剰引数。c を渡す者だけ検出するが JS は余剰引数を無視し無害な場合あり → semantic
      // 中間削除/並び替え/追加は位置がずれ確実に破壊 → structural
      const trailingRemoval = paramTag === 'arg-removed' && postParams.every((p, i) => p === preParams[i]);
      const conf: Confidence = trailingRemoval ? 'semantic' : 'structural';
      once(`${k}:${paramTag}`, () => out.push(make(b, paramTag, conf,
        `(${preParams.join(', ')}) → (${postParams.join(', ')})`)));
    }

    // 2b) return-changed: 返り値（整形だけの差＝関数↔アロー等の一部ノイズは空白正規化で無視）
    //   識別子の名前の付け替えだけの差（`bytesToUuid(b)` → `stringify(b)`）も出さない
    const ra = normReturns(a.returnExprs);
    const rb = normReturns(b.returnExprs);
    if (ra !== rb && (ra || rb)
      && !sameReturnsModuloRenaming(a.returnExprs ?? [], b.returnExprs ?? [], importsOf(pre, a), importsOf(post, b))) {
      once(`${k}:return-changed`, () => out.push(make(b, 'return-changed', 'semantic',
        `return: [${ra}] → [${rb}]`)));
    }

    // 2c) sync-to-async: 同期/非同期の変化（await 要否が変わる＝呼び出し側に影響）
    if ((a.isAsync ?? false) !== (b.isAsync ?? false)) {
      once(`${k}:sync-to-async`, () => out.push(make(b, 'sync-to-async', 'structural',
        `${a.isAsync ? 'async' : 'sync'} → ${b.isAsync ? 'async' : 'sync'}`)));
    }

    // 2d) export-style-changed: クライアントから見た公開名の変化（accessPath のプロパティ名。例 typeofrequest.is → typeis）
    //   accessPath の先頭はライブラリ内の変数名なので比べない（uuid 3.0.0 の uuid.v1 と 3.0.1 の exports の v1 は同じ require('uuid').v1）
    if (publicNameOf(a) !== publicNameOf(b)) {
      once(`${k}:export-style-changed`, () => out.push(make(b, 'export-style-changed', 'semantic',
        `${a.accessPath || '(直接)'} → ${b.accessPath || '(直接)'}`)));
    }

    // 2e) option-removed: options オブジェクトの受理キー変化（分割代入 or opts.key 読み取りベース）
    const preKeys = new Set(a.optionKeys ?? []);
    const postKeys = new Set(b.optionKeys ?? []);
    if (preKeys.size > 0) {
      // 追加(option-added)は加算的で非破壊のため損失候補にしない。削除のみ BC 損失として出す
      const removed = [...preKeys].filter(key => !postKeys.has(key));
      if (removed.length > 0) {
        once(`${k}:option-removed`, () => out.push(make(b, 'option-removed', 'semantic',
          `削除キー: ${removed.join(', ')}`)));
      }
    }

    // 2f) new-required: 関数↔class の変化（class は new 必須・関数は new 任意 → 呼び出し側の new 要否が変わる）
    if ((a.kind === 'class') !== (b.kind === 'class')) {
      once(`${k}:new-required`, () => out.push(make(b, 'new-required', 'structural',
        `${a.kind} → ${b.kind}`)));
    }
  };

  const byEntry = !!pre.entryFile && !!post.entryFile && post.symbols.some(s => s.filePath === post.entryFile);
  if (byEntry) {
    // 1)+2) 入口の公開名（require(lib).<名前>・default）ごとに比べる。入口でないファイルは 4) のファイル単位だけで見る
    //   default が入口から消えたときは 3e) entry-default-removed で出す
    const postApis = entryApis(post);
    for (const [key, a] of entryApis(pre)) {
      const b = postApis.get(key);
      if (b) {
        compareSignatures(a, b);
        continue;
      }
      if (key === 'default') continue;
      const removedTag: ChangeTag = a.kind === 'value' ? 'export-removed' : 'function-removed';
      once(`${a.name}:${a.filePath}:${removedTag}`, () => out.push(make(a, removedTag, 'structural')));
    }
  } else {
    // 1)+2) 配られるファイルの export 名 × 全定義(ファイル)を走査
    const preByName = indexByName(pre);
    const postByName = indexByName(post);
    for (const [name, preSymsAll] of preByName) {
      const preSyms = preSymsAll.filter(s => !unpublished.has(s.filePath));
      if (preSyms.length === 0) continue;
      const postSyms = postByName.get(name) ?? [];
      const preFiles = new Set(preSyms.map(s => s.filePath));
      const postFiles = new Set(postSyms.map(s => s.filePath));
      // 名前は残るが pre/post でファイルが全く重ならない＝定義の移動（クリーンな relocation）
      // TODO:コードの類似度を見ても面白そう
      const relocated = postSyms.length > 0 && ![...preFiles].some(f => postFiles.has(f));

      // 定義=ファイル単位で対応付け（同名が複数ファイルにあっても全て評価）
      for (const a of preSyms) {
        let b = postSyms.find(s => s.filePath === a.filePath);
        // 削除タグは種別で出し分け（関数=function-removed / 非関数 export=export-removed）
        const removedTag: ChangeTag = a.kind === 'value' ? 'export-removed' : 'function-removed';

        // 1) function-removed / export-removed: 対応する post 定義（同ファイル）が無い
        if (!b) {
          // 名前ごと消滅 → function/export-removed（symbol 使用の検出用）
          if (postSyms.length === 0) {
            once(`${name}:${a.filePath}:${removedTag}`, () => out.push(make(a, removedTag, 'structural')));
            continue;
          }
          // 全ファイル移動（クリーンな relocation）のみ、移動先を対応先にして署名比較を継続。
          // 一部ファイルだけ消え名前が別ファイルに残る場合は無関係な定義比較を避けるためスキップ（サブパス破壊は file-level）
          if (!relocated) continue;
          b = postSyms[0];
        }
        compareSignatures(a, b);
      }
    }
  }

  // 3a) node-npm-requirement-raised: engines(node/npm) 下限引き上げ＝それ未満のランタイム利用者が install/実行で壊れる（symbol 非依存）
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

  // 3b) module-format-changed: モジュール形式(CJS/ESM)の変化＝require↔import の不整合で壊れる（symbol 非依存・package.json type 由来）
  if (pre.moduleType && post.moduleType && pre.moduleType !== post.moduleType) {
    out.push({
      libName, preVersion: pre.version, postVersion: post.version,
      symbol: '(module)', filePath: 'package.json',
      tag: 'module-format-changed', label: labelOf('module-format-changed'), confidence: 'structural',
      detail: `${pre.moduleType} → ${post.moduleType}`,
    });
  }
  // TODO: 代表 export の exportStyle が cjs-*→esm-* の変化も補助信号になり得る（FP 影響を測ってから）

  // 3c) published-file-missing: post で新たに公開物から欠けたファイルを main から読む＝ライブラリの読み込み自体が失敗（symbol 非依存）
  //   git のツリーにはファイルが在るため surface の差分には現れない（例 get-value 1.3.0 の utils.js、sliced 1.0.0 の lib/sliced.js）
  const preMissing = new Set((pre.publishedMissing ?? []).map(m => m.target));
  const newMissing = (post.publishedMissing ?? []).filter(m => !preMissing.has(m.target));
  if (newMissing.length > 0) {
    out.push({
      libName, preVersion: pre.version, postVersion: post.version,
      symbol: '(package)', filePath: 'package.json',
      tag: 'published-file-missing', label: labelOf('published-file-missing'), confidence: 'structural',
      detail: newMissing.map(m => `${m.from} → ${m.spec}（${m.target} が公開物に無い）`).join(' / '),
    });
  }

  // 3d) exports-restricted: package.json exports の新設・縮小で、外から読めなくなったサブパス／本体の require
  const preEx = pre.packageExports;
  const postEx = post.packageExports;
  if (postEx) {
    const covers = (subpaths: string[], p: string) => subpaths.some(x =>
      x === p || x === './*' || (x.endsWith('/*') && p.startsWith(x.slice(0, -1))));
    const exportsCandidate = (symbol: string, detail: string, extra: Partial<LossCandidate> = {}): LossCandidate => ({
      libName, preVersion: pre.version, postVersion: post.version, symbol, filePath: 'package.json',
      tag: 'exports-restricted', label: labelOf('exports-restricted'), confidence: 'structural', detail, ...extra,
    });
    if (!preEx) {
      // exports の新設: 列挙されたサブパス以外への deep import がすべて ERR_PACKAGE_PATH_NOT_EXPORTED になる
      if (!postEx.subpaths.some(x => x === './*' || x === './')) {
        out.push(exportsCandidate('(exports)', `exports 新設（公開は ${postEx.subpaths.join(' ')} のみ）`, { exportsAllowed: postEx.subpaths }));
      }
      if (!postEx.rootRequire && pre.moduleType !== 'module') out.push(exportsCandidate('(require)', 'exports 新設で本体を require で読めない'));
    } else {
      for (const p of preEx.subpaths) {
        if (p !== '.' && !covers(postEx.subpaths, p)) out.push(exportsCandidate(p.replace(/^\.\//, ''), `exports から ${p} を削除`));
      }
      if (preEx.rootRequire && !postEx.rootRequire) out.push(exportsCandidate('(require)', 'exports の本体から require 条件を削除'));
    }
  }

  // 3e) entry-default-removed: pre の入口ファイルに default があり、post の入口ファイル（export を1件以上取れたもの）に default が無い
  //   例: uuid 3.4.0 index.js の module.exports = uuid → 7.0.0-beta.0 src/index.js は export { default as v1 } … だけ
  //   post の入口が ESM なら import x from 'lib' の x が undefined になる。CJS（module.exports = {…}）なら x() / new x() だけが壊れる
  const preEntryDefault = pre.entryFile ? pre.symbols.find(s => s.filePath === pre.entryFile && s.name === 'default') : undefined;
  const postEntrySyms = post.entryFile ? post.symbols.filter(s => s.filePath === post.entryFile) : [];
  if (preEntryDefault && postEntrySyms.length > 0 && !postEntrySyms.some(s => s.name === 'default')) {
    const entryEsm = post.moduleType === 'module' || postEntrySyms.some(s => s.exportStyle.startsWith('esm-'));
    out.push({
      libName, preVersion: pre.version, postVersion: post.version,
      symbol: 'default', filePath: preEntryDefault.filePath,
      tag: 'entry-default-removed', label: labelOf('entry-default-removed'), confidence: 'structural',
      detail: `${pre.entryFile} の default（${preEntryDefault.kind}）→ ${post.entryFile} に default なし（${entryEsm ? 'ESM' : 'CJS'}）`,
      entryEsm,
    });
  }

  // 4) file-level: pre のファイルが post で消えた＝サブパス import が壊れる。1サブパス=1件（per-name の冗長を排除）
  //   4a deep-import-broken: 名前が post に生存＝移動 ／ 4b module-removed: 名前が全消滅＝削除（名前生存の有無で排他）
  const postNames = new Set(post.symbols.map(s => s.name));
  const postFiles = new Set(post.symbols.map(s => s.filePath));
  const preByFile = new Map<string, ApiSymbol[]>();
  for (const s of pre.symbols) {
    const arr = preByFile.get(s.filePath);
    if (arr) arr.push(s); else preByFile.set(s.filePath, [s]);
  }
  for (const [file, syms] of preByFile) {
    if (postFiles.has(file)) continue;                       // ファイルは残っている
    if (unpublished.has(file)) continue;                     // npm で配られないファイルは読み込めない
    const moved = syms.some(s => postNames.has(s.name));     // 名前が post に生存＝移動
    // ディレクトリごと消えた（post に同じディレクトリ配下の export ファイルが無い）なら、その配下への deep import はすべて壊れる
    const dir = path.posix.dirname(file);
    const goneSubpath = dir !== '.' && ![...postFiles].some(f => f.startsWith(`${dir}/`)) ? deriveDirSubpath(dir) : '';
    out.push({
      libName, preVersion: pre.version, postVersion: post.version,
      symbol: deriveSubpath(file), filePath: file,
      tag: moved ? 'deep-import-broken' : 'module-removed',
      label: labelOf(moved ? 'deep-import-broken' : 'module-removed'),
      confidence: 'structural',
      detail: moved ? `${file} 移動（deep import 破壊）` : `${file} 削除`,
      ...(goneSubpath ? { goneDir: goneSubpath } : {}),
    });
  }

  return out;
}

// ファイルパスから公開サブパスの手がかりを作る（拡張子・先頭のビルド root・末尾 /index を除く）
export function deriveSubpath(filePath: string): string {
  return filePath
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/^(src|lib|dist|build|source|esm|cjs)\//, '')
    .replace(/\/index$/, '');
}

// ディレクトリから公開サブパスを作る（先頭のビルド root を除く。root そのものなら ''）
// 例 src/util → util / lib → ''
function deriveDirSubpath(dir: string): string {
  return dir.replace(/^(src|lib|dist|build|source|esm|cjs)(\/|$)/, '');
}

export default {
  diffSurface,
};
