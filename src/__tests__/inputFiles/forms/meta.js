async function fetchData(url, opts) { return opts.headers + opts.method; }
function make({ retry, timeout }) { return retry; }
module.exports = { fetchData, make };
