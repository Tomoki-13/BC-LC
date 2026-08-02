import { getExportedNames } from '../astRelated/trace/getExportedNames';

// 非関数 export 名（変数・値・object メンバ）を getFunction とは別に拾えるか検証する
const DIR = './src/__tests__/inputFiles/valueExports';
const names = async (file: string) => (await getExportedNames(`${DIR}/${file}`)).map(e => e.name).sort();

describe('getExportedNames: 非関数 export 名の網羅', () => {
  test('CJS: module.exports = { 関数 + 非関数 }（VERSION/config を拾う）', async () => {
    expect(await names('cjs_mixed.js')).toEqual(['VERSION', 'config', 'encode']);
  });

  test('CJS: exports.MAX / module.exports.TABLE のプロパティ代入（非関数も）', async () => {
    expect(await names('cjs_props.js')).toEqual(['MAX', 'TABLE', 'run']);
  });

  test('CJS: module.exports = <object識別子>（he 型・DELIM を拾う）', async () => {
    expect(await names('cjs_ident.js')).toEqual(['DELIM', 'decode']);
  });

  test('ESM: export const/let/named（VERSION/table/NAMES を拾う）', async () => {
    expect(await names('esm_values.mjs')).toEqual(['NAMES', 'VERSION', 'build', 'table']);
  });

  test('CJS: 公開実体の静的プロパティ（big.js 型 Big.version/Big.DP）', async () => {
    // module.exports = Big の静的プロパティを拾う（prototype は除外）
    expect(await names('cjs_static.js')).toEqual(['DP', 'default', 'roundHalfUp', 'version']);
  });

  test('ESM: 公開クラスの static メンバ（instance メソッドは対象外）', async () => {
    expect(await names('esm_class_static.mjs')).toEqual(['Cache', 'MAX', 'create']);
  });
});
