import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import semver from 'semver';
import ApiSurfaceExtractor from '../libDiff/apiSurface';
import LibRepo from '../libDiff/libRepo';
import DiffSurface, { entryApis, labelOf } from '../libDiff/diffSurface';
import { generatePatterns } from '../patternGen/generatePatterns';
import { extractClientUsage } from '../clientDetect/extract/extractUsage';
import { typeAwarePatternMatch } from '../clientDetect/match/typeAwarePatternMatch';
import { quietly } from '../utils/runLog';
import { DEPENDENCY_CLONE_BASE, toDirName, type DepChange } from '../utils/evalShared';
import { LOSS_TAGS, type ApiSurface, type ApiSymbol, type LossCandidate } from '../types/LibDiff';
import type { GeneratedPattern } from '../types/patternTypes';
import { buildLibraryFunctionGraph, enclosingFunction, findCallersReaching, type LibraryFunction, type LibraryFunctionGraph } from './libraryFunctionGraph';

/** 依存パッケージ1つ（範囲が変わったもの）を調べた結果 */
export interface DependencyCheck {
  dependency: string;
  fromRange: string;
  toRange: string;
  fromVersion?: string;   // 範囲の下限
  toVersion?: string;
  // no_source＝クローンが無い／not_semver＝範囲から下限を決められない／same_version＝下限が同じ／ref_unresolved＝バージョンのコミットが見つからない
  // repository_mismatch＝コミットは見つかったが package.json の name・version が違う（別のパッケージのリポジトリ・monorepo）
  // surface_failed＝export を取れない／no_loss＝依存パッケージに損失が無い／not_used＝ライブラリが損失した API を使っていない
  // used_not_public＝使っているが公開関数までたどれない／hit＝公開関数に及ぶ
  // range_overlap＝前後の範囲が重なる（同じ時期にインストールすれば前後とも同じバージョンが入るので調べない）
  status: 'no_source' | 'not_semver' | 'same_version' | 'range_overlap' | 'ref_unresolved' | 'repository_mismatch' | 'surface_failed' | 'no_loss' | 'not_used' | 'used_not_public' | 'hit';
  dependencyLosses?: string[];           // 依存パッケージの損失（タグ:名前）
  affected?: { publicName: string; dependencyLoss: string; route: string; depth: number }[];
}

interface DependencyAnalysis {
  status: 'no_source' | 'ref_unresolved' | 'repository_mismatch' | 'surface_failed' | 'no_loss' | 'loss';
  losses: LossCandidate[];
  patterns: GeneratedPattern[];
}

// 依存パッケージ × バージョンペアの判定は，どのライブラリから使っても同じなので1回だけ行う
const analysisCache = new Map<string, Promise<DependencyAnalysis>>();

/** クローンの ref のツリーを一時フォルダに取り出す（作業ツリーは切り替えない） */
export function extractVersionTree(repoDir: string, ref: string, label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bclc-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));
  execSync(`git -C "${repoDir}" archive "${ref}" | tar -x -C "${dir}"`, { stdio: 'ignore', maxBuffer: 256 * 1024 * 1024 });
  return dir;
}

/** 依存パッケージの clone（<パッケージ>/<owner>__<repo>/．バージョンによってリポジトリが違うことがあるので複数ありうる） */
export function dependencyRepoDirs(cloneBase: string, name: string): string[] {
  const base = path.resolve(process.cwd(), cloneBase, toDirName(name));
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).map(d => path.join(base, d)).filter(d => fs.existsSync(path.join(d, '.git')));
}

/** ref の package.json の name と version（読めなければ null） */
function packageAt(repoDir: string, ref: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(execSync(`git -C "${repoDir}" show "${ref}:package.json"`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

/**
 * 依存パッケージのバージョンのコミットを，clone の中から探す
 *   ref の package.json の name が一致し，version も一致するか，ref をタグで見つけたものだけを使う（別のパッケージのリポジトリ・monorepo の root のタグを読まないため．
 *   タグで見つけたものを許すのは，package.json の version を 0.0.0-development などのまま公開するパッケージがあるため）
 */
export function findDependencyVersion(repoDirs: string[], name: string, version: string): { repoDir: string; ref: string } | 'ref_unresolved' | 'repository_mismatch' {
  let resolvedSomewhere = false;
  for (const repoDir of repoDirs) {
    const { ref, method } = LibRepo.resolveRefDetailed(repoDir, version);
    if (!ref) continue;
    resolvedSomewhere = true;
    const pkg = packageAt(repoDir, ref);
    if (pkg?.name === name && (pkg?.version === version || method === 'tag')) return { repoDir, ref };
  }
  return resolvedSomewhere ? 'repository_mismatch' : 'ref_unresolved';
}

/** 依存パッケージの2つのバージョンで損失判定を行い，損失とそのパターン（環境の条件を除く）を返す */
function analyzeDependency(name: string, fromVersion: string, toVersion: string, cloneBase: string): Promise<DependencyAnalysis> {
  const key = `${cloneBase}|${name}@${fromVersion}..${toVersion}`;
  const cached = analysisCache.get(key);
  if (cached) return cached;
  const run = (async (): Promise<DependencyAnalysis> => {
    const repoDirs = dependencyRepoDirs(cloneBase, name);
    if (repoDirs.length === 0) return { status: 'no_source', losses: [], patterns: [] };
    const from = findDependencyVersion(repoDirs, name, fromVersion);
    const to = findDependencyVersion(repoDirs, name, toVersion);
    if (typeof from === 'string') return { status: from, losses: [], patterns: [] };
    if (typeof to === 'string') return { status: to, losses: [], patterns: [] };
    const dirs: string[] = [];
    try {
      dirs.push(extractVersionTree(from.repoDir, from.ref, `${name}-${fromVersion}`), extractVersionTree(to.repoDir, to.ref, `${name}-${toVersion}`));
      const pre = await ApiSurfaceExtractor.buildApiSurface(dirs[0], fromVersion, from.ref);
      const post = await ApiSurfaceExtractor.buildApiSurface(dirs[1], toVersion, to.ref);
      if (pre.symbols.length === 0 || post.symbols.length === 0) return { status: 'surface_failed', losses: [], patterns: [] };
      // engines の引き上げはライブラリのクライアントの環境の条件になるが，今は扱わない
      const losses = DiffSurface.diffSurface(pre, post, name)
        .filter(c => LOSS_TAGS.has(c.tag) && c.tag !== 'node-npm-requirement-raised' && c.tag !== 'dependency-breaking-change');
      const patterns = generatePatterns(losses, pre, post).patterns.filter(p => !p.env);
      return { status: losses.length > 0 ? 'loss' : 'no_loss', losses, patterns };
    } catch {
      return { status: 'surface_failed', losses: [], patterns: [] };
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  })();
  analysisCache.set(key, run);
  return run;
}

/** 公開関数（入口の公開名）が定義されている場所（ファイルと名前）。再公開をたどった記号は定義元 */
function definitionsOf(surface: ApiSurface, sym: ApiSymbol): { file: string; names: string[] }[] {
  const defs = [{ file: sym.filePath, names: [sym.localName, sym.name].filter((n): n is string => !!n) }];
  if (sym.resolvedFrom) {
    const [file, name] = sym.resolvedFrom.split('#');
    const def = surface.symbols.find(s => s.filePath === file && s.name === name);
    defs.push({ file, names: [def?.localName, name].filter((n): n is string => !!n) });
  }
  return defs;
}

/**
 * ライブラリのバージョンペアで範囲が変わった依存パッケージを調べ，（postTree はライブラリの更新後のツリーを返す関数．依存パッケージに損失があるときだけ呼ぶ）依存パッケージの破壊的変更が及ぶ公開関数を損失候補（dependency-breaking-change）にする
 *   1) 依存パッケージの範囲の下限どうしで損失判定（今のライブラリと同じ判定．engines の引き上げは除く）
 *   2) ライブラリの更新後のソースをクライアントとみなし，依存パッケージの損失のパターンを当てる
 *   3) 当たった行を含む関数から呼び出し元をたどり，入口の公開名の関数に着いたらそれを候補にする
 *   入口で依存パッケージをそのまま公開している（module.exports = require('依存パッケージ') など）ときは，損失した名前をそのまま候補にする
 */
export async function findDependencyBreakingChanges(
  libName: string, preVersion: string, postVersion: string, post: ApiSurface, postTree: () => string, depChanges: DepChange[],
  cloneBase: string = DEPENDENCY_CLONE_BASE,
): Promise<{ candidates: LossCandidate[]; checks: DependencyCheck[] }> {
  const candidates: LossCandidate[] = [];
  const checks: DependencyCheck[] = [];
  const seen = new Set<string>();
  let graph: LibraryFunctionGraph | null = null;
  const publics = [...entryApis(post).entries()];
  const targetOf = (fn: LibraryFunction) => publics.find(([, sym]) =>
    definitionsOf(post, sym).some(d => d.file === fn.file && d.names.includes(fn.name)));

  const addCandidate = (sym: ApiSymbol, publicName: string, dependencyLoss: string, route: string, depth: number, check: DependencyCheck) => {
    check.affected!.push({ publicName, dependencyLoss, route, depth });
    const key = `${sym.name}|${sym.filePath}|${dependencyLoss}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      libName, preVersion, postVersion, symbol: sym.name, filePath: sym.filePath,
      tag: 'dependency-breaking-change', label: labelOf('dependency-breaking-change'), confidence: 'semantic',
      detail: `${check.dependency}@${check.fromVersion}..${check.toVersion} ${dependencyLoss} → ${route}（${depth} 段）`,
    });
  };

  for (const change of depChanges) {
    if (change.kind !== 'dependencies' || (change.change !== 'major-bump' && change.change !== 'minor-patch-bump')) continue;
    const check: DependencyCheck = { dependency: change.name, fromRange: change.preRange ?? '', toRange: change.postRange ?? '', status: 'not_semver' };
    checks.push(check);
    const fromVersion = safeMinVersion(change.preRange);
    const toVersion = safeMinVersion(change.postRange);
    if (!fromVersion || !toVersion) continue;
    Object.assign(check, { fromVersion, toVersion });
    if (fromVersion === toVersion) { check.status = 'same_version'; continue; }
    if (rangesOverlap(change.preRange!, change.postRange!)) { check.status = 'range_overlap'; continue; }

    const analysis = await analyzeDependency(change.name, fromVersion, toVersion, cloneBase);
    if (analysis.status !== 'loss') { check.status = analysis.status; continue; }
    check.dependencyLosses = [...new Set(analysis.losses.map(l => `${l.tag}:${l.symbol}`))];
    check.affected = [];

    // 入口で依存パッケージをそのまま公開している記号
    for (const [publicName, sym] of publics) {
      if (sym.reexport?.spec !== change.name) continue;
      for (const loss of analysis.losses) {
        if (sym.reexport.imported === 'default') {
          addCandidate({ ...sym, name: loss.symbol }, loss.symbol, `${loss.tag}:${loss.symbol}`, `${sym.filePath} が ${change.name} をそのまま公開`, 0, check);
        } else if (sym.reexport.imported === loss.symbol) {
          addCandidate(sym, publicName, `${loss.tag}:${loss.symbol}`, `${sym.filePath} の ${publicName} が ${change.name} の ${loss.symbol} を公開`, 0, check);
        }
      }
    }

    // ライブラリのソースの中で損失した API を使う箇所
    const postTreeDir = postTree();
    const used = await quietly(() => extractClientUsage(postTreeDir, change.name));
    const match = used ? typeAwarePatternMatch(analysis.patterns, used.usageByFile) : { matched: false, hits: [] };
    if (match.matched) {
      graph ??= await buildLibraryFunctionGraph(postTreeDir);
      for (const hit of match.hits) {
        const file = path.relative(postTreeDir, hit.file).split(path.sep).join('/');
        const start = enclosingFunction(graph, file, hit.line);
        if (!start) continue;
        for (const { target, path: route } of findCallersReaching(graph, start, fn => !!targetOf(fn))) {
          const [publicName, sym] = targetOf(target)!;
          const routeText = [`${file}:${hit.line}`, ...route.map(fn => `${fn.file}#${fn.name}`)].join(' → ');
          addCandidate(sym, publicName, `${hit.pattern.tag}:${hit.pattern.symbol}`, routeText, route.length - 1, check);
        }
      }
    }
    check.status = check.affected.length > 0 ? 'hit' : match.matched ? 'used_not_public' : 'not_used';
  }
  return { candidates, checks };
}

export function rangesOverlap(preRange: string, postRange: string): boolean {
  try {
    return semver.intersects(preRange, postRange);
  } catch {
    return false;
  }
}

function safeMinVersion(range?: string): string | null {
  if (!range) return null;
  try {
    return semver.minVersion(range)?.version ?? null;
  } catch {
    return null;
  }
}
