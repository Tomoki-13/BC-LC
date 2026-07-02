function addArg(a, b) { return a; }          // arg-added (1→2)
function dropArg(a) { return a; }            // arg-removed (2→1)
function reorder(b, a) { return [a, b]; }    // arg-reordered
function spec(x) { return x * 3; }           // return-changed
async function load(p) { return p; }         // sync-to-async
function stable(a) { return a; }             // 変化なし

// removed は削除
module.exports = { addArg, dropArg, reorder, spec, load, stable };
