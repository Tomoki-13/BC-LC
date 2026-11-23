import fs from 'fs';
import path from 'path';
import traverseImport, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import getAllFiles from '../utils/getAllFiles';
import { createAstFromFile } from '../astRelated/base/createAstFromFile';

const traverse = ((traverseImport as any).default ?? traverseImport) as typeof traverseImport;
const SOURCE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

/** 呼び出し元をたどる段数の上限（循環は訪問済みで止まる。これは念のための上限） */
export const MAX_CALLER_DEPTH = 50;

/** ライブラリの関数1つ（名前つきの関数だけ。無名の関数はいちばん近い名前つきの関数に含める） */
export interface LibraryFunction {
  file: string;          // ツリーからの相対パス（/ 区切り）
  name: string;          // 関数名（module.exports = function … は 'default'）
  startLine: number;
  endLine: number;
  calls: Set<string>;    // 中で呼ぶ・new する名前（f(…) の f，x.m(…) の m）
}

export interface LibraryFunctionGraph {
  functions: LibraryFunction[];
  callersOf: Map<string, LibraryFunction[]>; // 名前 → その名前を呼ぶ関数
}

/** 関数のノードに付く名前（無名なら null） */
function functionName(p: NodePath<t.Function>): string | null {
  const node = p.node;
  if ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) && node.id) {
    // module.exports = function name() {} は default
    const parent = p.parentPath;
    if (parent?.isAssignmentExpression() && isModuleExports(parent.node.left)) return 'default';
    return node.id.name;
  }
  if ((t.isClassMethod(node) || t.isObjectMethod(node)) && t.isIdentifier(node.key)) return node.key.name;
  const parent = p.parentPath;
  if (!parent) return null;
  if (parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return parent.node.id.name;
  if (parent.isObjectProperty() && t.isIdentifier(parent.node.key)) return parent.node.key.name;
  if (parent.isClassProperty() && t.isIdentifier(parent.node.key)) return parent.node.key.name;
  if (parent.isAssignmentExpression()) {
    const left = parent.node.left;
    if (isModuleExports(left)) return 'default';
    if (t.isMemberExpression(left) && t.isIdentifier(left.property) && !left.computed) return left.property.name;
    if (t.isIdentifier(left)) return left.name;
  }
  if (parent.isExportDefaultDeclaration()) return 'default';
  return null;
}

function isModuleExports(n: t.Node): boolean {
  return t.isMemberExpression(n) && t.isIdentifier(n.object, { name: 'module' }) && t.isIdentifier(n.property, { name: 'exports' });
}

/** 呼び出し・new の対象の名前 */
function calleeName(callee: t.Node): string | null {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) return callee.property.name;
  return null;
}

/** 1ファイルの名前つき関数を集める */
function functionsInFile(treeDir: string, absPath: string): LibraryFunction[] {
  let code: string;
  try {
    code = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }
  const ast = createAstFromFile(absPath, code);
  if (!ast) return [];
  const file = path.relative(treeDir, absPath).split(path.sep).join('/');
  const out: LibraryFunction[] = [];
  const byNode = new Map<t.Node, LibraryFunction>();
  const addCall = (p: NodePath, callee: t.Node) => {
    const name = calleeName(callee);
    if (!name) return;
    const owner = p.findParent(a => a.isFunction() && byNode.has(a.node));
    if (owner) byNode.get(owner.node)!.calls.add(name);
  };
  traverse(ast, {
    Function(p: NodePath<t.Function>) {
      const name = functionName(p);
      if (!name || !p.node.loc) return;
      const fn: LibraryFunction = { file, name, startLine: p.node.loc.start.line, endLine: p.node.loc.end.line, calls: new Set() };
      out.push(fn);
      byNode.set(p.node, fn);
    },
    CallExpression(p: NodePath<t.CallExpression>) {
      addCall(p, p.node.callee);
    },
    NewExpression(p: NodePath<t.NewExpression>) {
      addCall(p, p.node.callee);
    },
  });
  return out;
}

/** ツリーのソースファイル（getAllFiles の除外に従う）から関数の一覧と呼び出し元の表を作る */
export async function buildLibraryFunctionGraph(treeDir: string): Promise<LibraryFunctionGraph> {
  const files = (await getAllFiles(treeDir)).filter(f => SOURCE_EXT.includes(path.extname(f)));
  const functions = files.flatMap(f => functionsInFile(treeDir, f));
  const callersOf = new Map<string, LibraryFunction[]>();
  for (const fn of functions) {
    for (const c of fn.calls) {
      const arr = callersOf.get(c);
      if (arr) arr.push(fn); else callersOf.set(c, [fn]);
    }
  }
  return { functions, callersOf };
}

/** file の line を含む名前つき関数のうち，いちばん内側のもの（無ければ null＝ファイルの直下） */
export function enclosingFunction(graph: LibraryFunctionGraph, file: string, line: number): LibraryFunction | null {
  let best: LibraryFunction | null = null;
  for (const fn of graph.functions) {
    if (fn.file !== file || line < fn.startLine || line > fn.endLine) continue;
    if (!best || fn.endLine - fn.startLine < best.endLine - best.startLine) best = fn;
  }
  return best;
}

/**
 * start から呼び出し元を名前でたどり，isTarget に当たる関数とそこまでの経路を返す（start 自身も調べる）
 *   名前だけで呼び出しを結ぶので，同じ名前の別の関数も呼び出し元に入る
 */
export function findCallersReaching(
  graph: LibraryFunctionGraph, start: LibraryFunction, isTarget: (fn: LibraryFunction) => boolean, maxDepth = MAX_CALLER_DEPTH,
): { target: LibraryFunction; path: LibraryFunction[] }[] {
  const found: { target: LibraryFunction; path: LibraryFunction[] }[] = [];
  const visited = new Set<LibraryFunction>([start]);
  let frontier: LibraryFunction[][] = [[start]];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: LibraryFunction[][] = [];
    for (const route of frontier) {
      const fn = route[route.length - 1];
      if (isTarget(fn)) found.push({ target: fn, path: route });
      for (const caller of graph.callersOf.get(fn.name) ?? []) {
        if (visited.has(caller)) continue;
        visited.add(caller);
        next.push([...route, caller]);
      }
    }
    frontier = next;
  }
  return found;
}
