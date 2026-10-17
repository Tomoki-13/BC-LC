import fs from 'fs';
import path from 'path';
import type { PublishedMissing } from '../types/LibDiff';

// npm が files 指定に関係なく常に同梱するファイル（ルート直下）
const ALWAYS_SHIPPED = /^(package\.json|readme[^/]*|licen[cs]e[^/]*|changelog[^/]*)$/i;
const JS_EXT = /\.(c|m)?js$/;
// 相対パスの require / import / 動的 import（./ ../ で始まる指定子のみ）
const RELATIVE_SPEC = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** ツリー配下の全ファイルを repo 相対・/ 区切りで列挙（.git と node_modules は除外） */
function listTree(treeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out.push(path.relative(treeDir, abs).split(path.sep).join('/'));
    }
  };
  walk(treeDir);
  return out;
}

/** package.json files の1エントリを正規表現へ（ディレクトリ指定は配下すべて・* は1階層・** は任意階層） */
function entryToRegExp(entry: string): RegExp {
  const g = entry.replace(/^\.\//, '').replace(/\/$/, '');
  const src = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${src}(/.*)?$`);
}

/** 相対指定子を Node の解決順（そのまま → 拡張子補完 → /index）でツリー内のファイルに解決。無ければ null */
function resolveRelative(fromFile: string, spec: string, tree: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const c of [base, `${base}.js`, `${base}.json`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`, `${base}/index.json`]) {
    if (tree.has(c)) return c;
  }
  return null;
}

/**
 * 公開物（npm に載るファイル）から欠けたファイルを、main から辿れる相対 require で探す
 *   入力: checkout 済みの版ツリー / 出力: 欠落の一覧（package.json に files 指定が無ければ undefined＝判定対象外）
 *   公開集合 = files 指定に一致するファイル ＋ 常に同梱されるファイル ＋ main。ツリーには在るが公開集合に無いファイルを
 *   main から（公開ファイル間の相対 require を辿って）読み込むと、npm から入れた利用者は読み込み時に Cannot find module で失敗する
 */
export function findPublishedMissing(treeDir: string): PublishedMissing[] | undefined {
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(pkg?.files)) return undefined; // files 無指定は .npmignore 依存で公開集合を確定できない

  const treeList = listTree(treeDir);
  const tree = new Set(treeList);
  const include = pkg.files.filter((f: unknown) => typeof f === 'string' && !f.startsWith('!')).map(entryToRegExp);
  const exclude = pkg.files.filter((f: unknown) => typeof f === 'string' && f.startsWith('!')).map((f: string) => entryToRegExp(f.slice(1)));
  const mainSpec = typeof pkg.main === 'string' && pkg.main.length > 0 ? pkg.main : 'index.js';
  const main = resolveRelative('package.json', mainSpec.startsWith('.') ? mainSpec : `./${mainSpec}`, tree);
  const shipped = new Set(treeList.filter(f =>
    ALWAYS_SHIPPED.test(f) || f === main || (include.some((r: RegExp) => r.test(f)) && !exclude.some((r: RegExp) => r.test(f)))));

  if (!main) return [];
  const missing: PublishedMissing[] = [];
  if (!shipped.has(main)) {
    missing.push({ from: 'package.json#main', spec: mainSpec, target: main });
    return missing;
  }

  // main から公開ファイル間の相対 require を辿る（欠落ファイルの先は読めないので辿らない）
  const seen = new Set<string>([main]);
  const queue = [main];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!JS_EXT.test(file)) continue;
    let src: string;
    try {
      src = fs.readFileSync(path.join(treeDir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(RELATIVE_SPEC)) {
      const target = resolveRelative(file, m[1], tree);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      if (shipped.has(target)) queue.push(target);
      else missing.push({ from: file, spec: m[1], target });
    }
  }
  return missing;
}
