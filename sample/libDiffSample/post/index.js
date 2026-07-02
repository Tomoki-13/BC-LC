module.exports.greet = function (name, opts) {
  return 'hi ' + name;
};
module.exports.add = function (a) {
  return a;
};
module.exports.swap = function (b, a) {
  return [a, b];
};
module.exports.compute = function (x) {
  return x * 3;
};
module.exports.load = async function (p) {
  return p;
};
