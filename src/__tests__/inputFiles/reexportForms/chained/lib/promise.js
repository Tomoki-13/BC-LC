function Promise(resolver) {
  if (!(this instanceof Promise)) {
    return new Promise(resolver);
  }
  this.state = resolver;
}
module.exports = Promise;
