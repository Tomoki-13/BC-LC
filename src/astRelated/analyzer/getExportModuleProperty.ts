import { promises as fsPromises } from 'fs';
import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { ModuleExportProperty } from '../../types/FunctionInfo';
// TODO: 組み込みがまだ module.id.exports が判定できるように組み込む

/**
 * 指定されたノードが 'module.exports.someIdentifier' の形式か判定する関数
 */
function isModuleExportsProperty(
  node: t.Node,
): node is t.MemberExpression & { property: t.Identifier } {
  return (
    t.isMemberExpression(node) &&
    t.isMemberExpression(node.object) &&
    t.isIdentifier(node.object.object, { name: 'module' }) &&
    t.isIdentifier(node.object.property, { name: 'exports' }) &&
    t.isIdentifier(node.property)
  );
}

/**
 * 'module.exports.prop = funcName' 関連の割り当てを抽出し、プロパティ名と右辺のコードを返す
 * @param filePath 解析対象のファイルパス
 * @param funcName 追跡対象の関数名 (右辺で使われているか)
 * @returns 抽出結果の配列
 */
export const getExportModuleProperty = async (
  filePath: string,
  funcName: string,
): Promise<ModuleExportProperty[]> => {
  // 関数内で結果配列を初期化 (引数での受け取りを廃止)
  const resultArray: ModuleExportProperty[] = [];
  try {
    if (!filePath.endsWith('.js') && !filePath.endsWith('.ts')) {
      return resultArray;
    }

    const fileContent: string = await fsPromises.readFile(filePath, 'utf8');
    const parsed = parser.parse(fileContent, {
      sourceType: 'unambiguous',
      plugins: ['typescript', 'decorators-legacy'],
    });

    traverse(parsed, {
      AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
        const { node } = path;
        const left = node.left;
        const right = node.right;

        // 左辺 (LHS) が 'module.exports.someProperty' かチェック
        if (!isModuleExportsProperty(left)) {
          return; // 該当しなければこの時点で処理を終了
        }

        let isMatch = false;
        if (t.isIdentifier(right, { name: funcName })) {
          // ケースA: module.exports.prop = funcName
          isMatch = true;
        } else if (
          t.isMemberExpression(right) &&
          t.isIdentifier(right.object, { name: funcName })
        ) {
          // ケースB: module.exports.prop = funcName.member
          isMatch = true;
        } else if (
          t.isCallExpression(right) &&
          t.isMemberExpression(right.callee) &&
          t.isIdentifier(right.callee.object, { name: funcName })
        ) {
          // ケースC: module.exports.prop = funcName.member()
          isMatch = true;
        }

        // マッチした場合のみ結果を抽出 (コードの重複を排除)
        if (isMatch) {
          // start/end が null でないことを確認 (TypeScriptの型安全のため)
          if (right.start != null && right.end != null) {
            const code: string = fileContent.substring(right.start, right.end);
            const propName = left.property.name;

            resultArray.push({
              property_name: propName,
              right_func: code,
            });
          }
        }
      },
    });
  } catch (error) {
    // console.log(`getExportModuleProperty: Failed to create AST for file: ${filePath}`,);
    // console.log(error);
  }

  return resultArray;
};
