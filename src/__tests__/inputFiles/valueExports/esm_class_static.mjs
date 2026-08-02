export class Cache {
  static create() {}   // static メソッド（← T1a.3 で拾う）
  static MAX = 100;    // static プロパティ
  get(k) { return k; } // インスタンスメソッド（static でないので対象外）
}
