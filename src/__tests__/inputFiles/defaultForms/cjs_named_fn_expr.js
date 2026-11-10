'use strict';
module.exports = function serialize(obj, options) {
  return String(obj) + options;
};
