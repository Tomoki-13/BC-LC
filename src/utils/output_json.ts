import * as fs from 'fs';

/** ディレクトリが無ければ再帰的に作成する（入力: パス / 出力: なし） */
const createOutputDirectory = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

/** Date を YYYY-MM-DD-HH-mm-ss 形式の文字列にする（RUN_ID・ファイル名用） */
function formatDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

export default {
  createOutputDirectory,
  formatDateTime,
};
