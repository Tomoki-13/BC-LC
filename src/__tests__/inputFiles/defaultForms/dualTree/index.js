'use strict';
function v4(family) {
  return family;
}
function v6() {
  return 6;
}
module.exports = v4;
module.exports.v4 = v4;
module.exports.v6 = v6;
