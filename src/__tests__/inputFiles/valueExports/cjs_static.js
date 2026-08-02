function Big(n) { return n; }
Big.version = '5.2.2';   // 静的プロパティ（← T1a.3 で拾う）
Big.DP = 20;             // 静的プロパティ
Big.roundHalfUp = function () {};  // 静的メソッド
module.exports = Big;
