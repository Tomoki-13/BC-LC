export { }
function add_default(a = 1, b) {
  return a + b;
}

function funcA(string) {
  return "OK";
}

function funcB(string) {
  return "No";
}

function funcC(string) {
  return "Yes";
}

function funcD(string) {
  return "Out";
}

module.exports = {
  // 識別子を直接指定
  funcA: funcA,
    // ネストされたオブジェクト構造
    to: {
    // ネスト内での指定
    funcB: funcB,

    // さらに深いネスト
    utils: {
      funcC: funcC
    }
  },
  funcE: funcD
};