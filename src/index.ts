import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { execSync } from 'child_process';

import OutputJson from './utils/output_json';
import ApiSurfaceExtractor from './libDiff/apiSurface';     // 差分取得: surface 抽出
import DiffSurface from './libDiff/diffSurface';            // 差分取得: pre/post 比較
import LibRepo from './libDiff/libRepo';                    // 差分取得: git 操作
import JudgeLoss from './core/judgeLoss';                   // 機能1: 損失判定
import GeneratePattern from './core/generatePattern';       // 機能2: パターン化
import { fetchVersionList, fetchVersionMeta, extractRepositoryUrl } from './collectDataset/npm/registry';
import type { ApiSurface } from './types/LibDiff';

// 実行 ID（Meta の BCPG_RUN_ID を優先、無ければ生成）
// 出力は history/BC-LC/libDiff/<RUN_ID>/<lib>/ に書き、実行末尾で latest/BC-LC/libDiff/<lib>/ にコピー
const RUN_ID: string = process.env.BCPG_RUN_ID ?? OutputJson.formatDateTime(new Date());

// 入出力パス（process.cwd() = BC-LC/src 基準でメタリポ配下を参照）
const PATHS = {
  libCloneBase: '../../clonedata/lib_versions',                       // <lib>/（全版入りの単一クローン・使い捨て）
  historyBase: `../../outputs/history/BC-LC/libDiff/${RUN_ID}`,       // <lib>/{surfaces,pairs}/
  latestBase: '../../outputs/latest/BC-LC/libDiff',                   // <lib>/{surfaces,pairs}/
};

const cleanVersion = (v: string): string => v.replace(/[^a-zA-Z0-9]/g, '');
const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');

const surfacePath = (safeName: string, cv: string): string =>
  path.resolve(process.cwd(), PATHS.historyBase, safeName, 'surfaces', `${cv}.json`);
const pairPath = (safeName: string, cvPre: string, cvPost: string): string =>
  path.resolve(process.cwd(), PATHS.historyBase, safeName, 'pairs', `${cvPre}__${cvPost}.json`);
const patternPath = (safeName: string, cvPre: string, cvPost: string): string =>
  path.resolve(process.cwd(), PATHS.historyBase, safeName, 'patterns', `${cvPre}__${cvPost}.json`);

/** history/<RUN_ID>/<lib> を latest/<lib> にコピー（lib 単位で latest を更新・蓄積） */
function copyToLatest(safeName: string): void {
  const src = path.resolve(process.cwd(), PATHS.historyBase, safeName);
  const dst = path.resolve(process.cwd(), PATHS.latestBase, safeName);
  if (!fs.existsSync(src)) return;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`[Latest] ${dst}`);
}

function parseArgs(): { libraryName: string } {
  const [lib] = process.argv.slice(2);
  if (!lib) { console.error('使い方: npx tsx index.ts <lib>'); process.exit(1); }
  return { libraryName: lib };
}

/** 解析対象の版一覧（semver 昇順。マイナー含む全公開版） */
async function getTargetVersions(libraryName: string): Promise<string[]> {
  const all = await fetchVersionList(libraryName);
  return all.filter(v => semver.valid(v)).sort(semver.compare);
}

/** clone 元 URL（最新版メタの repository から） */
async function getRepoUrl(libraryName: string, latest: string): Promise<string | null> {
  const meta = await fetchVersionMeta(libraryName, latest);
  return extractRepositoryUrl(meta);
}

/** キャッシュ済み surface を読む（無ければ null） */
function readSurface(safeName: string, cv: string): ApiSurface | null {
  const p = surfacePath(safeName, cv);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ApiSurface;
}

/** 各版の surface を抽出・キャッシュ（既存はスキップ・1版1回） */
async function buildSurfaces(repoDir: string, safeName: string, versions: string[]): Promise<void> {
  for (const v of versions) {
    const out = surfacePath(safeName, cleanVersion(v));
    if (fs.existsSync(out)) continue;

    const tag = LibRepo.resolveTag(repoDir, v);
    if (!tag) { console.warn(`[Skip] タグ未解決: ${v}`); continue; }

    LibRepo.checkoutVersion(repoDir, tag);
    const surface = await ApiSurfaceExtractor.buildApiSurface(repoDir, v, tag);

    OutputJson.createOutputDirectory(path.dirname(out));
    fs.writeFileSync(out, JSON.stringify(surface, null, 2));
    console.log(`[Surface] ${v} → ${surface.symbols.length} exports`);
  }
}

/** 連続する版ペアごとに: 差分取得 → 損失判定(機能1) → パターン化(機能2) */
function diffPairs(libraryName: string, safeName: string, versions: string[]): void {
  for (let i = 0; i + 1 < versions.length; i++) {
    const pre = versions[i];
    const post = versions[i + 1];
    const preSurface = readSurface(safeName, cleanVersion(pre));
    const postSurface = readSurface(safeName, cleanVersion(post));
    if (!preSurface || !postSurface) continue;

    // 差分取得（libDiff）
    const changes = DiffSurface.diffSurface(preSurface, postSurface, libraryName);
    // 機能1: 後方互換性の損失を判定
    const losses = JudgeLoss.judge(changes);
    const lossOut = pairPath(safeName, cleanVersion(pre), cleanVersion(post));
    OutputJson.createOutputDirectory(path.dirname(lossOut));
    fs.writeFileSync(lossOut, JSON.stringify(losses, null, 2));

    // 機能2: 損失をパターン化（あれば出力）
    const patterns = GeneratePattern.generate(losses);
    if (patterns.length > 0) {
      const patOut = patternPath(safeName, cleanVersion(pre), cleanVersion(post));
      OutputJson.createOutputDirectory(path.dirname(patOut));
      fs.writeFileSync(patOut, JSON.stringify(patterns, null, 2));
    }

    console.log(`[Diff] ${pre} → ${post}: losses=${losses.length}, patterns=${patterns.length}`);
  }
}

/**
 * ローカル入力モード: 版ごとのサブディレクトリを持つフォルダを直接解析（clone/registry 不要）
 * 例: npx tsx index.ts --local ../sample/testLib [出力名]
 *     <dir>/<version>/... を版として buildApiSurface し、連続ペアで diff
 */
async function runLocal(dirArg: string, nameArg?: string): Promise<void> {
  const dir = path.resolve(process.cwd(), dirArg);
  const name = nameArg || path.basename(dir);
  const safeName = safe(name);

  const versions = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => (semver.valid(a) && semver.valid(b)) ? semver.compare(a, b) : a.localeCompare(b));
  if (versions.length < 2) { console.error('[Error] 版ディレクトリが2つ未満です'); process.exit(1); }

  for (const v of versions) {
    const surface = await ApiSurfaceExtractor.buildApiSurface(path.join(dir, v), v, v);
    const out = surfacePath(safeName, cleanVersion(v));
    OutputJson.createOutputDirectory(path.dirname(out));
    fs.writeFileSync(out, JSON.stringify(surface, null, 2));
    console.log(`[Surface] ${v} → ${surface.symbols.length} exports`);
  }
  diffPairs(name, safeName, versions);
  copyToLatest(safeName);
  console.log(`[Done] 出力(latest): ${path.resolve(process.cwd(), PATHS.latestBase, safeName)}`);
}

/** タグ解決（無ければ npm の gitHead コミットで代替。beta 等タグ無し版むけ） */
async function resolveRef(repoDir: string, lib: string, version: string): Promise<string | null> {
  const tag = LibRepo.resolveTag(repoDir, version);
  if (tag) return tag;
  try {
    const meta = await fetchVersionMeta(lib, version);
    const sha = meta?.gitHead;
    if (sha) {
      execSync(`git -C "${repoDir}" cat-file -t ${sha}`, { stdio: 'ignore' });
      return sha;
    }
  } catch {
    /* fallback 失敗 */
  }
  return null;
}

/**
 * 特定の版ペア(pre,post)だけを比較するモード
 * 例: npx tsx index.ts --pair uuid 3.4.0 7.0.0-beta.0
 */
async function runPair(lib: string, pre: string, post: string): Promise<void> {
  const safeName = safe(lib);
  const repoDir = path.resolve(process.cwd(), PATHS.libCloneBase, safeName);

  if (!fs.existsSync(repoDir)) {
    const meta = await fetchVersionMeta(lib, post);
    const url = extractRepositoryUrl(meta);
    if (!url) { console.error('[Error] repoUrl を特定できず clone 不可'); process.exit(1); }
    console.log(`[Clone] ${url}`);
    LibRepo.ensureClone(url, repoDir, process.env.GITHUB_TOKEN);
  }

  const preRef = await resolveRef(repoDir, lib, pre);
  const postRef = await resolveRef(repoDir, lib, post);
  if (!preRef || !postRef) { console.error(`[Error] ref 未解決 pre=${preRef} post=${postRef}`); process.exit(1); }

  LibRepo.checkoutVersion(repoDir, preRef);
  const preSurface = await ApiSurfaceExtractor.buildApiSurface(repoDir, pre, preRef);
  LibRepo.checkoutVersion(repoDir, postRef);
  const postSurface = await ApiSurfaceExtractor.buildApiSurface(repoDir, post, postRef);

  // surface をキャッシュ保存
  for (const s of [preSurface, postSurface]) {
    const sp = surfacePath(safeName, cleanVersion(s.version));
    OutputJson.createOutputDirectory(path.dirname(sp));
    fs.writeFileSync(sp, JSON.stringify(s, null, 2));
  }

  // 差分取得 → 機能1(判定) → 機能2(パターン化)
  const losses = JudgeLoss.judge(DiffSurface.diffSurface(preSurface, postSurface, lib));
  const out = pairPath(safeName, cleanVersion(pre), cleanVersion(post));
  OutputJson.createOutputDirectory(path.dirname(out));
  fs.writeFileSync(out, JSON.stringify(losses, null, 2));

  const patterns = GeneratePattern.generate(losses);
  if (patterns.length > 0) {
    const po = patternPath(safeName, cleanVersion(pre), cleanVersion(post));
    OutputJson.createOutputDirectory(path.dirname(po));
    fs.writeFileSync(po, JSON.stringify(patterns, null, 2));
  }

  copyToLatest(safeName);
  console.log(`[Diff] ${lib} ${pre} → ${post}: exports ${preSurface.symbols.length}→${postSurface.symbols.length}, losses=${losses.length}`);
  console.log(`[Done] 出力(latest): ${path.resolve(process.cwd(), PATHS.latestBase, safeName, 'pairs', `${cleanVersion(pre)}__${cleanVersion(post)}.json`)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--local') {
    await runLocal(args[1], args[2]);
    return;
  }
  if (args[0] === '--pair') {
    await runPair(args[1], args[2], args[3]);
    return;
  }

  const { libraryName } = parseArgs();
  const safeName = safe(libraryName);
  const repoDir = path.resolve(process.cwd(), PATHS.libCloneBase, safeName);

  const versions = await getTargetVersions(libraryName);
  if (versions.length < 2) { console.error('[Error] 比較に必要な版が足りません'); process.exit(1); }

  // クローン用意（collectDataset が clone 済みなら再利用）
  if (!fs.existsSync(repoDir)) {
    const repoUrl = await getRepoUrl(libraryName, versions[versions.length - 1]);
    if (!repoUrl) { console.error('[Error] repoUrl を特定できず clone 不可'); process.exit(1); }
    LibRepo.ensureClone(repoUrl, repoDir, process.env.GITHUB_TOKEN);
  }

  await buildSurfaces(repoDir, safeName, versions);
  diffPairs(libraryName, safeName, versions);
  copyToLatest(safeName);

  console.log(`[Done] 出力(latest): ${path.resolve(process.cwd(), PATHS.latestBase, safeName)}`);
}

main().catch(e => {
  console.error('[Fatal]', e);
  process.exit(1);
});
