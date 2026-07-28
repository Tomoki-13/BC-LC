import fs from 'fs';
import path from 'path';
import traverseImport from '@babel/traverse';
import * as t from '@babel/types';
import { createAstFromContent } from '../astRelated/base/createAstFromFile';
import type { ApiSurface, ApiSymbol, ScopeMode, ApiUsage } from '../types/LibDiff';

const traverse = ((traverseImport as any).default ?? traverseImport) as typeof traverseImport;

const TEST_DIR = new Set(['__tests__', 'test', 'tests', 'spec', 'specs']);
// foo.test.js / foo.spec.ts に加え、ルート直下の test.js / spec.js 単体も拾う
const isTestFile = (f: string) =>
  /(^|\.)(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(f))
  || f.split(path.sep).some(seg => TEST_DIR.has(seg));
const isSourceFile = (f: string) => /\.[cm]?[jt]sx?$/.test(f);
const isMarkdown = (f: string) => /\.(md|markdown)$/i.test(f);
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g; // ドキュメント本文の識別子トークン抽出用

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

/**
 * ドキュメント由来の「言及された名前」を集める（散文含む全識別子トークン ∩ 後段で export 名と照合）
 *   docs は require+呼び出しのコード例が少なく散文で API 名に触れるため、AST でなくトークン照合を使う
 *   onlyReadme=true: 直下 README のみ / false: 全 .md（CHANGELOG 等の版までのリリースノート含む）
 *   extraTexts: repo 外のドキュメント（GitHub Releases 本文等）を足したいとき
 */
function collectDocTokens(repoDir: string, onlyReadme: boolean, extraTexts: string[] = []): ApiUsage {
  const named = new Set<string>();
  const addTokens = (text: string) => { for (const m of text.matchAll(IDENT_RE)) named.add(m[0]); };
  const files = onlyReadme
    ? readdirSafe(repoDir).filter(e => e.isFile() && /^readme/i.test(e.name)).map(e => path.join(repoDir, e.name))
    : walk(repoDir).filter(isMarkdown);
  for (const f of files) { const src = readText(f); if (src) addTokens(src); }
  for (const text of extraTexts) addTokens(text);
  return { named, defaultUsed: false, deepPaths: new Set() };
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
  collectDocTokens,
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

  // errorRecovery でパースできても traverse のスコープ解析が重複宣言等で throw しうるので保護
  try {
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
  } catch {
    /* 壊れた/重複宣言のコード片は無視 */
  }
}
