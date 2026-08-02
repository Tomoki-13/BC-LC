function encode(s) { return s; }
module.exports = {
  encode: encode,        // 関数（getFunction が拾う）
  VERSION: '1.0.0',      // 文字列値（← 従来欠落）
  config: { a: 1 },      // オブジェクト値（← 従来欠落）
};
