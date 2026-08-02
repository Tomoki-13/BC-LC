function decode(s) { return s; }
var lib = { decode: decode, DELIM: ',' };  // DELIM は非関数（← 従来欠落）
module.exports = lib;
