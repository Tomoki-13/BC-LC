module.exports.greet = function (name) {
  return 'hi ' + name;
};
module.exports.add = function (a, b) {
  return a + b;
};
module.exports.legacy = function () {
  return 1;
};
module.exports.swap = function (a, b) {
  return [a, b];
};
module.exports.compute = function (x) {
  return x * 2;
};
module.exports.load = function (p) {
  return p;
};
