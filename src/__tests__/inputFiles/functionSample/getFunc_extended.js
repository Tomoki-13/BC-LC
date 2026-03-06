// 1. returnExprs の抽出テスト
function calculateTotal(price, tax) {
  return price * tax;
}

// 2. prototypeObj, isInstanceMethod の抽出テスト
function Calculator() {}
Calculator.prototype.add = function(a, b) {
  return a + b;
};

// 3. isPotentialPrototype, isInstanceMethod の抽出テスト (P.method = ...)
const P = {};
P.multiply = function(a, b) {
  return a * b;
};

// 4. isPropertyFunction, propertyPath の抽出テスト
module.exports = {
  mathUtils: {
    divide: function(a, b) {
      return a / b;
    }
  }
};