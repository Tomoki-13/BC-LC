'use strict';
class SyntaxError extends Error {
  constructor(err) {
    super(err);
    this.name = 'Syntax Error';
  }
}
module.exports = SyntaxError;
