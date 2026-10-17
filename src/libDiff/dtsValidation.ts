// index.d.ts（ライブラリ同梱の型定義）で surface 抽出の妥当性を検証する
// ライブラリが型定義を持つ版のみ、宣言された値 export の何%を surface が捕捉できたか（coverage / missing）を返す
import fs from 'fs';
import path from 'path';
import type { ApiSymbol, DtsValidation } from '../types/LibDiff';
import { createAstFromFile } from '../astRelated/base/createAstFromFile';

// 型のみ export（ランタイムに無いので coverage の分母から除く）の宣言ノード種別
const TYPE_DECLS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration']);
// 値として実在する宣言ノード種別（declare function / const / class）
const VALUE_DECLS = new Set(['TSDeclareFunction', 'FunctionDeclaration', 'VariableDeclaration', 'ClassDeclaration']);

// .d.ts の default export を表す名前（surface の default export と対応させる）
export const DTS_DEFAULT = 'default';

// export 宣言ノードから宣言される名前を取り出す
function declaredNames(decl: any): string[] {
  if (!decl) return [];
  if (decl.type === 'VariableDeclaration') return (decl.declarations ?? []).map((d: any) => d.id?.name).filter(Boolean);
  return decl.id?.name ? [decl.id.name] : [];
}
const specifierName = (spec: any): string | null =>
  spec.exported?.type === 'Identifier' ? spec.exported.name
    : spec.exported?.type === 'StringLiteral' ? spec.exported.value : null;
const keyName = (key: any): string | null =>
  key?.type === 'Identifier' ? key.name : key?.type === 'StringLiteral' ? key.value : null;

// 型リテラル／interface 本体のメンバのうち値になるもの（メソッド・プロパティ）。呼び出しシグネチャは default 側で扱う
function typeMemberNames(members: any[]): string[] {
  return members
    .filter(m => m.type === 'TSMethodSignature' || m.type === 'TSPropertySignature')
    .map(m => keyName(m.key))
    .filter((n): n is string => !!n && n !== DTS_DEFAULT);
}

const CALLABLE_MEMBERS = new Set(['TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration']);

// 型注釈を、読める部分（型リテラル・同じファイルの interface）のメンバに分解する
//   A & B は両方を合わせる。関数型は呼べる。読めない参照（外部の型・namespace 内の型）は unresolved
function resolveType(ann: any, interfaces: Map<string, any[]>): { members: any[]; callable: boolean; unresolved: boolean } {
  if (!ann) return { members: [], callable: false, unresolved: true };
  if (ann.type === 'TSFunctionType' || ann.type === 'TSConstructorType') return { members: [], callable: true, unresolved: false };
  if (ann.type === 'TSTypeLiteral') {
    const members = ann.members ?? [];
    return { members, callable: members.some((m: any) => CALLABLE_MEMBERS.has(m.type)), unresolved: false };
  }
  if (ann.type === 'TSTypeReference' && ann.typeName?.type === 'Identifier' && interfaces.has(ann.typeName.name)) {
    const members = interfaces.get(ann.typeName.name)!;
    return { members, callable: members.some((m: any) => CALLABLE_MEMBERS.has(m.type)), unresolved: false };
  }
  if (ann.type === 'TSIntersectionType') {
    const parts = (ann.types ?? []).map((t: any) => resolveType(t, interfaces));
    return {
      members: parts.flatMap((p: any) => p.members),
      callable: parts.some((p: any) => p.callable),
      unresolved: parts.every((p: any) => p.unresolved),
    };
  }
  return { members: [], callable: false, unresolved: true };
}

// 同じ本体の interface 宣言（同名はマージ）
function interfacesOf(body: any[]): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const node of body) {
    if (node.type === 'TSInterfaceDeclaration' && node.id?.name) {
      out.set(node.id.name, [...(out.get(node.id.name) ?? []), ...(node.body?.body ?? [])]);
    }
  }
  return out;
}

const variableType = (body: any[], name: string): any | undefined => {
  for (const node of body) {
    if (node.type !== 'VariableDeclaration') continue;
    const d = (node.declarations ?? []).find((x: any) => x.id?.name === name);
    if (d) return d.id.typeAnnotation?.typeAnnotation ?? null;
  }
  return undefined;
};

/**
 * export = X の X が呼び出せる（関数・クラス）か。呼び出せない object（プロパティの集まり）は default を値 export に数えない
 *   declare function X / declare class X / const X: (…) => T → 呼べる
 *   declare const X: { (…): T; … } / interface・A & B のどこかに呼び出しシグネチャ → 呼べる
 *   declare const X: { a: T; … }（シグネチャ無し）・declare namespace X だけ → 呼べない
 *   型が読めない（外部の型・型注釈なし）→ 呼べるとみなす
 */
function isCallableExport(body: any[], name: string): boolean {
  if (body.some(n => (n.type === 'TSDeclareFunction' || n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id?.name === name)) return true;
  const ann = variableType(body, name);
  if (ann === undefined) return !body.some(n => n.type === 'TSModuleDeclaration' && n.id?.name === name); // namespace だけ＝object
  const t = resolveType(ann, interfacesOf(body));
  return t.callable || t.unresolved;
}

/**
 * export = X（CJS）の X が持つ値メンバ
 *   declare namespace X { function a(); const b }  → a, b（namespace 内の値宣言）
 *   declare const X: { a(): void; b: string }       → a, b（型リテラルのメンバ）
 *   declare const X: XType ＋ interface XType {...}  → interface のメンバ（A & B は両方）
 */
function exportAssignedMembers(body: any[], name: string): string[] {
  const out = new Set<string>();
  for (const node of body) {
    if (node.type === 'TSModuleDeclaration' && node.id?.name === name && node.body?.type === 'TSModuleBlock') {
      for (const inner of node.body.body ?? []) {
        const decl = inner.type === 'ExportNamedDeclaration' ? inner.declaration : inner;
        if (decl && VALUE_DECLS.has(decl.type)) for (const n of declaredNames(decl)) out.add(n);
      }
    }
  }
  const ann = variableType(body, name);
  if (ann) typeMemberNames(resolveType(ann, interfacesOf(body)).members).forEach(n => out.add(n));
  return [...out];
}

// declare module 'lib' { … } で包まれた宣言は、その中身をモジュールの本体として読む
function moduleBody(program: any[]): any[] {
  const wrapped = program.filter(n => n.type === 'TSModuleDeclaration' && n.id?.type === 'StringLiteral' && n.body?.type === 'TSModuleBlock');
  return [...program, ...wrapped.flatMap(n => n.body.body ?? [])];
}

/**
 * .d.ts の export 名を「値」と「型のみ」に分けて抽出（Babel AST・typescript プラグイン）
 *   export default と、呼び出せる X の export = X は default（モジュール本体）として数え、export = X は X の値メンバも値 export に含める
 *   型のみ export（interface/type/enum/namespace）はランタイムに無いので coverage の分母から除く
 */
export function parseDtsExports(dtsPath: string, content: string): { value: Set<string>; type: Set<string> } {
  const value = new Set<string>();
  const type = new Set<string>();
  const ast = createAstFromFile(dtsPath, content); // .d.ts は拡張子 .ts 判定で typescript プラグインが付く
  if (!ast) return { value, type };

  const body = moduleBody(ast.program.body as any[]);
  for (const node of body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const bucket = TYPE_DECLS.has(node.declaration.type) ? type : value; // function/const/class/TSDeclareFunction は値
        for (const n of declaredNames(node.declaration)) bucket.add(n);
      }
      for (const spec of (node.specifiers ?? [])) {                           // export { A, B as C } / export type { ... }
        const n = specifierName(spec);
        if (!n) continue;
        (node.exportKind === 'type' || spec.exportKind === 'type' ? type : value).add(n);
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      value.add(DTS_DEFAULT);
    } else if (node.type === 'TSExportAssignment') {                           // export = X（CJS の module.exports = X）
      const name = node.expression?.type === 'Identifier' ? node.expression.name : null;
      if (!name || isCallableExport(body, name)) value.add(DTS_DEFAULT);
      if (name) exportAssignedMembers(body, name).forEach(n => value.add(n));
    }
  }
  return { value, type };
}

/** surface が default export（モジュール本体）を持つか */
const hasDefaultExport = (symbols: ApiSymbol[]) =>
  symbols.some(s => s.name === DTS_DEFAULT || s.exportStyle === 'cjs-module-default' || s.exportStyle === 'esm-default');

/**
 * 版ツリーの .d.ts（package.json types/typings → index.d.ts の順）で surface 抽出の妥当性を検証
 * 入力: 版ツリー / その版の抽出済み symbols
 * 出力: DtsValidation（型定義が無ければ hasDts:false。値 export が0件なら coverage は付けない）
 */
export function validateAgainstDts(treeDir: string, symbols: ApiSymbol[]): DtsValidation {
  let dtsRel: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf-8'));
    const t = pkg?.types || pkg?.typings;
    if (typeof t === 'string') { const p = t.endsWith('.d.ts') ? t : `${t}.d.ts`; if (fs.existsSync(path.join(treeDir, p))) dtsRel = p; }
  } catch { /* package.json 無し等はスキップ */ }
  if (!dtsRel && fs.existsSync(path.join(treeDir, 'index.d.ts'))) dtsRel = 'index.d.ts';
  if (!dtsRel) return { hasDts: false };

  let content: string;
  try { content = fs.readFileSync(path.join(treeDir, dtsRel), 'utf-8'); } catch { return { hasDts: false }; }
  return compareDtsWithSurface(dtsRel, content, symbols);
}

/** .d.ts の内容と surface の symbols を突き合わせる（validateAgainstDts の本体。ファイルを読まない） */
export function compareDtsWithSurface(dtsRel: string, content: string, symbols: ApiSymbol[]): DtsValidation {
  const { value, type } = parseDtsExports(dtsRel, content);
  if (value.size === 0) return { hasDts: true, dtsFile: dtsRel, dtsExportCount: 0, typeExportCount: type.size, matchedCount: 0, missing: [] };
  const surfaceNames = new Set(symbols.map(s => s.name));
  const captured = (n: string) => (n === DTS_DEFAULT ? hasDefaultExport(symbols) : surfaceNames.has(n));
  const missing = [...value].filter(n => !captured(n));
  const matchedCount = value.size - missing.length;
  return { hasDts: true, dtsFile: dtsRel, dtsExportCount: value.size, typeExportCount: type.size, matchedCount, coverage: +(matchedCount / value.size).toFixed(3), missing };
}
