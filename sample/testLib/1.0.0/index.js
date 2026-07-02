function removed() { return 0; }            // → 2.0.0 で削除: function-removed
function addArg(a) { return a; }            // → 引数増加: arg-added
function dropArg(a, b) { return a + b; }    // → 引数削除: arg-removed
function reorder(a, b) { return [a, b]; }   // → 引数並び替え: arg-reordered
function spec(x) { return x * 2; }          // → 返り値変更(同一sig): return-changed
function load(p) { return p; }              // → 非同期化: sync-to-async
function stable(a) { return a; }            // → 変化なし(対照): 候補に出ないこと

module.exports = { removed, addArg, dropArg, reorder, spec, load, stable };
