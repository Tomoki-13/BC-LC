import fs from 'fs';
import path from 'path';
import traverseImport from '@babel/traverse';
import * as t from '@babel/types';
import { createAstFromContent } from '../analyzer/astRelated/base/createAstFromFile';
import type { ApiSurface, ApiSymbol, ScopeMode, ApiUsage } from '../types/LibDiff';

const traverse = ((traverseImport as any).default ?? traverseImport) as typeof traverseImport;

const TEST_DIR = new Set(['__tests__', 'test', 'tests', 'spec', 'specs']);
// foo.test.js / foo.spec.ts に加え、ルート直下の test.js / spec.js 単体も拾う
const isTestFile = (f: string) =>
  /(^|\.)(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(f))
  || f.split(path.sep).some(seg => TEST_DIR.has(seg));
const isSourceFile = (f: string) => /\.[cm]?[jt]sx?$/.test(f);
const isMarkdown = (f: string) => /\.(md|markdown)$/i.test(f);

/** テスト由来の使用実態を集める（テストは相対 import で自パッケージを読むため relative も lib 扱い） */
function collectTestUsage(repoDir: string, libName: string): ApiUsage {
  const usage = emptyUsage();
  for (const f of walk(repoDir)) {
    if (!isTestFile(f) || !isSourceFile(f)) continue;
    const src = readText(f); if (!src) continue;
    resolveUsageFromCode(src, libName, true, usage);
  }
  return usage;
}

/** md 由来の使用実態を集める（onlyReadme=true なら直下 README のみ / false なら全 .md=リリースノート等含む） */
// TODO: GitHub Releases API 上のリリースノート（repo に md が無いケース）は未対応。repo 内 .md のみ対象
function collectMarkdownUsage(repoDir: string, libName: string, onlyReadme: boolean): ApiUsage {
  const usage = emptyUsage();
  const files = onlyReadme
    ? readdirSafe(repoDir).filter(e => e.isFile() && /^readme/i.test(e.name)).map(e => path.join(repoDir, e.name))
    : walk(repoDir).filter(isMarkdown);
  for (const f of files) {
    const src = readText(f); if (!src) continue;
    for (const code of extractCodeFences(src)) resolveUsageFromCode(code, libName, false, usage);
  }
  return usage;
}

/** surface のシンボルを使用実態で絞る（mode0 は無変換） */
function filterSurface(surface: ApiSurface, mode: ScopeMode, usage: ApiUsage): ApiSurface {
  if (mode === 0) return surface;
  const keep = (s: ApiSymbol): boolean =>
    usage.named.has(s.name)
    || (usage.defaultUsed && (s.name === 'default' || s.exportStyle === 'esm-default' || s.exportStyle === 'cjs-module-default'))
    || [...usage.deepPaths].some(dp => matchesDeepPath(s.filePath, dp));
  return { ...surface, symbols: surface.symbols.filter(keep) };
}


export default {
  collectTestUsage,
  collectMarkdownUsage,
  filterSurface,
};

const emptyUsage = (): ApiUsage => ({ named: new Set(), defaultUsed: false, deepPaths: new Set() });
const readText = (f: string): string | null => { try { return fs.readFileSync(f, 'utf-8'); } catch { return null; } };
const readdirSafe = (d: string): fs.Dirent[] => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

/** dir 配下を再帰列挙（node_modules と .git は除外） */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSafe(dir)) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** markdown から js/ts 系コードフェンスの中身を抽出 */
function extractCodeFences(md: string): string[] {
  const out: string[] = [];
  const re = /```([a-zA-Z0-9]*)\r?\n([\s\S]*?)```/g;
  for (const m of md.matchAll(re)) {
    const lang = m[1].toLowerCase();
    if (lang === '' || ['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'node', 'cjs', 'mjs'].includes(lang)) out.push(m[2]);
  }
  return out;
}

/** filePath('lib/util.js') が deep import サブパス('lib/util')に一致するか */
function matchesDeepPath(filePath: string, deep: string): boolean {
  const noExt = filePath.replace(/\.[cm]?[jt]sx?$/, '');
  return noExt === deep || noExt === `${deep}/index`;
}

/**
 * 1つのコード片から、対象 lib の import を追跡して使用 API を usage に加える
 *   allowRelative=true なら相対 import も lib 扱い（テストは自パッケージを相対で読むため）
 */
function resolveUsageFromCode(code: string, libName: string, allowRelative: boolean, usage: ApiUsage): void {
  const ast = createAstFromContent(code);
  if (!ast) return;
  const libBindings = new Set<string>(); // default/namespace 束縛のローカル名
  const isLibSource = (src: string) => src === libName || src.startsWith(`${libName}/`) || (allowRelative && src.startsWith('.'));
  const recordDeep = (src: string) => { if (src.startsWith(`${libName}/`)) usage.deepPaths.add(src.slice(libName.length + 1)); };

  traverse(ast, {
    ImportDeclaration(p) {
      const src = p.node.source.value;
      if (!isLibSource(src)) return;
      recordDeep(src);
      for (const s of p.node.specifiers) {
        if (t.isImportDefaultSpecifier(s) || t.isImportNamespaceSpecifier(s)) libBindings.add(s.local.name);
        else if (t.isImportSpecifier(s)) usage.named.add(t.isIdentifier(s.imported) ? s.imported.name : s.local.name);
      }
    },
    VariableDeclarator(p) {
      const init = p.node.init;
      if (!t.isCallExpression(init) || !t.isIdentifier(init.callee, { name: 'require' })) return;
      const arg = init.arguments[0];
      if (!t.isStringLiteral(arg) || !isLibSource(arg.value)) return;
      recordDeep(arg.value);
      if (t.isIdentifier(p.node.id)) libBindings.add(p.node.id.name);
      else if (t.isObjectPattern(p.node.id)) {
        for (const pr of p.node.id.properties) if (t.isObjectProperty(pr) && !pr.computed && t.isIdentifier(pr.key)) usage.named.add(pr.key.name);
      }
    },
  });

  if (libBindings.size === 0) return;
  traverse(ast, {
    MemberExpression(p) {
      const n = p.node;
      if (!n.computed && t.isIdentifier(n.object) && libBindings.has(n.object.name) && t.isIdentifier(n.property)) usage.named.add(n.property.name);
    },
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee) && libBindings.has(p.node.callee.name)) usage.defaultUsed = true; // lib(...) 直接呼び出し
    },
    NewExpression(p) {
      if (t.isIdentifier(p.node.callee) && libBindings.has(p.node.callee.name)) usage.defaultUsed = true; // new Lib()（new X.Foo の Foo は MemberExpression が拾う）
    },
  });
}
