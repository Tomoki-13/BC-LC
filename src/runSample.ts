import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import OutputJson from './utils/output_json';
import ApiSurface from './libDiff/apiSurface';
import DiffSurface from './libDiff/diffSurface';
import LibRepo from './libDiff/libRepo';
import { fetchVersionMeta, extractRepositoryUrl } from './collectDataset/npm/registry';

const clean = (v: string) => v.replace(/[^a-zA-Z0-9]/g, '');
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** package.json の損失関連フィールドを抜粋 */
function readPkg(repoDir: string): any {
  const p = path.join(repoDir, 'package.json');
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return {
    name: j.name, version: j.version, type: j.type ?? 'commonjs',
    main: j.main, module: j.module, types: j.types ?? j.typings, exports: j.exports,
    dependencies: j.dependencies, peerDependencies: j.peerDependencies, engines: j.engines,
  };
}

/** .git / node_modules を除く全ファイル一覧（ディレクトリ構造の記録用） */
function listFiles(dir: string, base = dir, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(fp, base, acc);
    else acc.push(path.relative(base, fp));
  }
  return acc.sort();
}

/** import の呼び出し方に関わる package.json シグナル */
function importStyle(pkg: any): any {
  if (!pkg) return null;
  const conditions: string[] = [];
  const walk = (o: any) => {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) {
      if (['require', 'import', 'default', 'node', 'browser', 'types'].includes(k)) conditions.push(k);
      else walk(o[k]);
    }
  };
  if (pkg.exports && typeof pkg.exports === 'object') walk(pkg.exports);
  return {
    type: pkg.type,                                   // module なら ESM 既定
    hasMain: !!pkg.main,                              // CJS エントリ
    hasModule: !!pkg.module,                          // ESM エントリ
    hasExportsField: !!pkg.exports,                   // exports によるエントリ制限
    exportsSubpaths: pkg.exports && typeof pkg.exports === 'object' ? Object.keys(pkg.exports) : [],
    exportsConditions: [...new Set(conditions)],      // require/import 等の対応
  };
}

/** 依存の前後差分 */
function depDiff(pre: any = {}, post: any = {}): any {
  pre = pre ?? {}; post = post ?? {};
  const keys = new Set([...Object.keys(pre), ...Object.keys(post)]);
  const added: any[] = [], removed: any[] = [], changed: any[] = [];
  for (const k of keys) {
    if (!(k in pre)) added.push({ name: k, post: post[k] });
    else if (!(k in post)) removed.push({ name: k, pre: pre[k] });
    else if (pre[k] !== post[k]) changed.push({ name: k, pre: pre[k], post: post[k] });
  }
  return { added, removed, changed };
}

/** タグ解決を試し、無ければ npm の gitHead(コミットSHA) で代替（beta 等タグ無し版むけ） */
async function resolveRef(repoDir: string, lib: string, version: string): Promise<string | null> {
  const tag = LibRepo.resolveTag(repoDir, version);
  if (tag) return tag;
  try {
    const meta = await fetchVersionMeta(lib, version);
    const sha = meta?.gitHead;
    if (sha) {
      execSync(`git -C "${repoDir}" cat-file -t ${sha}`, { stdio: 'ignore' }); // 存在確認
      return sha;
    }
  } catch {
    /* fallback 失敗 */
  }
  return null;
}

async function main(): Promise<void> {
  const [libArg, preArg, postArg] = process.argv.slice(2);
  const lib = libArg || 'uuid';
  const pre = preArg || '3.4.0';
  const post = postArg || '7.0.0-beta.0';
  const safeName = safe(lib);

  const repoDir = path.resolve(process.cwd(), '../../clonedata/lib_versions', safeName);
  if (!fs.existsSync(repoDir)) {
    const meta = await fetchVersionMeta(lib, post);
    const url = extractRepositoryUrl(meta);
    if (!url) { console.error('[Error] repoUrl 不明'); process.exit(1); }
    console.log(`[Clone] ${url} → ${repoDir}`);
    LibRepo.ensureClone(url, repoDir, process.env.GITHUB_TOKEN);
  }

  const preTag = await resolveRef(repoDir, lib, pre);
  const postTag = await resolveRef(repoDir, lib, post);
  if (!preTag || !postTag) { console.error(`[Error] ref 未解決 pre=${preTag} post=${postTag}`); process.exit(1); }

  // pre
  LibRepo.checkoutVersion(repoDir, preTag);
  const preSurface = await ApiSurface.buildApiSurface(repoDir, pre, preTag);
  const prePkg = readPkg(repoDir);
  const preFiles = listFiles(repoDir);

  // post
  LibRepo.checkoutVersion(repoDir, postTag);
  const postSurface = await ApiSurface.buildApiSurface(repoDir, post, postTag);
  const postPkg = readPkg(repoDir);
  const postFiles = listFiles(repoDir);

  // 1) 外部 API（関数名/引数/移動）の損失候補
  const losses = DiffSurface.diffSurface(preSurface, postSurface, lib);

  // 2) npm / 依存 / engines の変化
  const packageDiff = {
    version: { pre: prePkg?.version, post: postPkg?.version },
    type: { pre: prePkg?.type, post: postPkg?.type },
    main: { pre: prePkg?.main, post: postPkg?.main },
    module: { pre: prePkg?.module, post: postPkg?.module },
    types: { pre: prePkg?.types, post: postPkg?.types },
    engines: { pre: prePkg?.engines, post: postPkg?.engines },
    dependencies: depDiff(prePkg?.dependencies, postPkg?.dependencies),
    peerDependencies: depDiff(prePkg?.peerDependencies, postPkg?.peerDependencies),
  };

  // 3) import 呼び出し方の変化
  const importStyleDiff = { pre: importStyle(prePkg), post: importStyle(postPkg) };

  // 4) ディレクトリ構造の変化
  const preSet = new Set(preFiles), postSet = new Set(postFiles);
  const structureDiff = {
    added: postFiles.filter(f => !preSet.has(f)),
    removed: preFiles.filter(f => !postSet.has(f)),
  };

  // 出力: history/<RUN_ID>/<lib@pair>/ に書き、latest/<lib@pair>/ にコピー
  const RUN_ID = process.env.BCPG_RUN_ID ?? OutputJson.formatDateTime(new Date());
  const pairName = `${safeName}@${clean(pre)}__${clean(post)}`;
  const outDir = path.resolve(process.cwd(), '../../outputs/history/BC-LC/sample', RUN_ID, pairName);
  const latestDir = path.resolve(process.cwd(), '../../outputs/latest/BC-LC/sample', pairName);
  OutputJson.createOutputDirectory(outDir);
  const w = (name: string, data: any) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2));
  w('surface_pre.json', preSurface);
  w('surface_post.json', postSurface);
  w('losses.json', losses);
  w('package_pre.json', prePkg);
  w('package_post.json', postPkg);
  w('package_diff.json', packageDiff);
  w('import_style.json', importStyleDiff);
  w('structure_diff.json', structureDiff);

  // latest へコピー
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(latestDir), { recursive: true });
  fs.cpSync(outDir, latestDir, { recursive: true });

  console.log(`[Done] ${lib} ${pre} → ${post}`);
  console.log(`  exports: pre=${preSurface.symbols.length} post=${postSurface.symbols.length}, losses=${losses.length}`);
  console.log(`  files: pre=${preFiles.length} post=${postFiles.length}, added=${structureDiff.added.length} removed=${structureDiff.removed.length}`);
  console.log(`  history: ${outDir}`);
  console.log(`  latest : ${latestDir}`);
}

main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
