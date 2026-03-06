/**
 * AST解析テスト用ファイル
 * 構成:
 * 1. Exportしていない関数 (Local)
 * 2. 様々なExport形式 (ESM, CJS)
 * 3. クラス定義 (Class Methods, Properties)
 */

// ==================================================
// 1. Exportしていない関数定義 (Local Scope)
// ==================================================

// [FunctionDeclaration] 通常の関数宣言
function localFunctionDeclaration(a, b) {
  return a + b;
}

// [VariableDeclarator -> ArrowFunctionExpression] ローカルのアロー関数
const localArrowFunction = (x) => {
  return x * x;
};

// [VariableDeclarator -> FunctionExpression] ローカルの関数式
const localFunctionExpression = function (y) {
  console.log(y);
};

// [FunctionDeclaration] ローカルのAsync関数
async function localAsyncFunction() {
  await Promise.resolve();
}


// ==================================================
// 2. 様々なExport形式 (Exports)
// ==================================================

// --- 直接的なExport (Direct Exports) ---

// [ExportNamedDeclaration -> FunctionDeclaration] 名前付きExport（関数宣言）
export function exportedFunctionDeclaration(a, b) {
  return a - b;
}

// [ExportNamedDeclaration -> VariableDeclaration] 名前付きExport（アロー関数）
export const exportedArrowFunction = (a, b) => a * b;

// [ExportNamedDeclaration -> VariableDeclaration] 名前付きExport（Async関数式）
export const exportedAsyncExpression = async function (url) {
  return await fetch(url);
};


// --- 定義後のExport (Export Specifiers) ---

// まず定義する
function declaredFirstFunction() { return 'defined first'; }
const declaredFirstArrow = () => 'defined first arrow';

// 後からまとめてExport
// [ExportNamedDeclaration -> ExportSpecifier]
export { declaredFirstFunction, declaredFirstArrow };


// --- エイリアスExport (Alias) ---

function internalNameFunction() { return 'internal'; }

// 外部には 'externalNameFunction' として公開される
// AST解析では specifier.local.name ('internalNameFunction') を追う必要がある
export { internalNameFunction as externalNameFunction };


// --- Default Export ---

// [ExportDefaultDeclaration -> FunctionDeclaration]
export default function defaultFunction(x) {
  return x + 1;
}
// 注意: 1ファイルに export default は1つしか書けないため、他パターンのテスト時は書き換えが必要


// --- CommonJS形式 (Legacy) ---

// [AssignmentExpression] module.exports への代入
module.exports.cjsModuleExportsFunction = function (a, b) {
  return a / b;
};

// [AssignmentExpression] exports へのアロー関数代入
exports.cjsExportsArrowFunction = (a, b) => {
  return Math.pow(a, b);
};


// ==================================================
// 3. クラス定義 (Class Definitions)
// ==================================================

// --- Exportされたクラス ---
export class ExportedClass {
  // [ClassMethod] 通常のメソッド
  exportedClassMethod(a) {
    return a;
  }

  // [ClassMethod] Asyncメソッド
  async exportedClassAsyncMethod() {
    return true;
  }

  // [ClassMethod] Staticメソッド
  static exportedClassStaticMethod() {
    return 'static';
  }

  // [ClassProperty -> ArrowFunctionExpression]
  exportedClassArrowProperty = (val) => {
    return val;
  };
}

// --- Exportされていないクラス ---
class LocalClass {
  // [ClassMethod]
  localClassMethod(b) {
    return b;
  }
}