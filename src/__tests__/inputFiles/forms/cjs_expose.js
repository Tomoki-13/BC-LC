function main(a) { return a; }
function v4impl() { return 4; }
main.v4 = v4impl;
main.helper = function (h) { return h; };
module.exports = main;
