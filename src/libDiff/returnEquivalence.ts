import * as parser from '@babel/parser';

// 名前を付け替えても同じものを指さない識別子（組み込みのオブジェクト・関数）
const GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'window', 'global', 'self', 'process', 'Buffer', 'console', 'require', 'module', 'exports',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Function', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'ArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'setImmediate', 'setInterval', 'clearTimeout', 'clearInterval', 'arguments',
]);

// 比べないキー（位置・コメント・括弧の有無など）
const SKIP_KEYS = new Set(['start', 'end', 'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'errors']);

// 名前そのものに意味がある位置（`a.b` の b・`{ b: 1 }` の b・メソッド名）
const isFixedNameSlot = (parent: any, key: string): boolean =>
  !parent.computed && (
    (key === 'property' && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression'))
    || (key === 'key' && ['ObjectProperty', 'ObjectMethod', 'ClassMethod', 'ClassProperty', 'ClassPrivateProperty', 'TSPropertySignature'].includes(parent.type))
  );

function parseExpr(code: string): any | null {
  for (const plugins of [['typescript'], ['jsx'], []] as parser.ParserPlugin[][]) {
    try {
      return parser.parseExpression(code, { plugins: [...plugins, 'decorators-legacy'] });
    } catch { /* 次の組み合わせで試す */ }
  }
  return null;
}

// `a ? a : b` は `a || b` と同じに扱う（uuid 8.0.0→8.1.0 の `buf ? buf : bytesToUuid(b)` → `buf || bytesToUuid(b)`）
function normalize(node: any): any {
  if (node?.type === 'ConditionalExpression' && node.test?.type === 'Identifier'
    && node.consequent?.type === 'Identifier' && node.test.name === node.consequent.name) {
    return { type: 'LogicalExpression', operator: '||', left: node.test, right: node.alternate };
  }
  return node;
}

interface Ctx {
  importsA: Record<string, string>;
  importsB: Record<string, string>;
  aToB: Map<string, string>;
  bToA: Map<string, string>;
}

const isPackageSpec = (spec: string | undefined) => spec !== undefined && !spec.startsWith('.');

function sameIdentifier(x: string, y: string, ctx: Ctx): boolean {
  if (GLOBALS.has(x) || GLOBALS.has(y)) return x === y;
  // パッケージから読み込んだ名前は、同じパッケージを指すときだけ付け替えとみなす（globby の glob → fastGlob は別物）
  const sa = Object.prototype.hasOwnProperty.call(ctx.importsA, x) ? ctx.importsA[x] : undefined; // `constructor` などの名前で Object の持ち物を拾わない
  const sb = Object.prototype.hasOwnProperty.call(ctx.importsB, y) ? ctx.importsB[y] : undefined;
  if ((isPackageSpec(sa) || isPackageSpec(sb)) && sa !== sb) return false;
  const mappedB = ctx.aToB.get(x);
  const mappedA = ctx.bToA.get(y);
  if (mappedB === undefined && mappedA === undefined) {
    ctx.aToB.set(x, y);
    ctx.bToA.set(y, x);
    return true;
  }
  return mappedB === y && mappedA === x;
}

function sameNode(a: any, b: any, ctx: Ctx, fixedName = false): boolean {
  a = normalize(a);
  b = normalize(b);
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameNode(x, b[i], ctx));
  }
  if (a.type !== b.type) return false;
  if (a.type === 'Identifier') return fixedName ? a.name === b.name : sameIdentifier(a.name, b.name, ctx);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => !SKIP_KEYS.has(k)));
  for (const k of keys) {
    if (!sameNode(a[k], b[k], ctx, isFixedNameSlot(a, k))) return false;
  }
  return true;
}

/**
 * 返り値の式の並びが、識別子の名前の付け替えを除いて同じかを AST で比べる
 *   付け替えとみなす: 引数・ローカル変数・同じパッケージ内のファイルから読み込んだ関数の名前（`x` → `input`、`bytesToUuid` → `stringify`）
 *   付け替えとみなさない: プロパティ名・メソッド名（`toUpperCase` → `toLocaleUpperCase`）、組み込みの名前、別のパッケージを指す名前
 *   名前の対応は1対1（`obj || obj` → `obj || res` は違う）。どれか1つでも parse できなければ false
 */
export function sameReturnsModuloRenaming(
  a: string[], b: string[],
  importsA: Record<string, string> = {}, importsB: Record<string, string> = {},
): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const ctx: Ctx = { importsA, importsB, aToB: new Map(), bToA: new Map() };
  for (let i = 0; i < a.length; i++) {
    const na = parseExpr(a[i]);
    const nb = parseExpr(b[i]);
    if (!na || !nb || !sameNode(na, nb, ctx)) return false;
  }
  return true;
}
