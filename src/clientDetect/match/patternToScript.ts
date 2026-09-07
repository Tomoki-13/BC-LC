/**
 * リテラル括弧をエスケープしつつ正規表現構文の括弧を温存する
 *   入力: 保存形パターン文字列 / 出力: new RegExp に渡せるソース
 *   (?<name> か (?! で始まる括弧は「特殊部」として最初の ) まで無加工で通す
 */
export function escapeFunc(str: string): string {
  let escaped = '';
  let inside = false; // 特殊部（名前付きグループ/否定先読み）の内側か
  const specialStart = /^\(\?(<[\w-]+>|!)/;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inside) {
      if (ch === ')') inside = false; // 特殊部は最初の ) で閉じる（内部に ) を持たない前提）
      escaped += ch;
    } else if (ch === '(') {
      if (specialStart.test(str.slice(i))) { inside = true; escaped += ch; }
      else escaped += '\\(';
    } else if (ch === ')') {
      escaped += '\\)';
    } else {
      escaped += ch;
    }
  }
  return escaped;
}

/** 保存形パターン文字列から RegExp を作る（複数行対応。不正パターンは null） */
export function toRegExp(storedRegex: string): RegExp | null {
  try {
    return new RegExp(escapeFunc(storedRegex), 'm');
  } catch {
    return null;
  }
}

/** binding 文字列から名前付きグループ名（variable\d+）を取り出す。無ければ null */
export function bindingVarKey(bindingRegex: string): string | null {
  const m = bindingRegex.match(/\(\?<(variable\d+)>/);
  return m ? m[1] : null;
}
