import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// BC-LC/.env を読む。実行したフォルダから上へ、src/utils/loadEnv.ts を持つフォルダ（BC-LC）を探す
//   tsx は ESM として動かすので __dirname は使えない。shell で export 済みの値は上書きしない
let dir = process.cwd();
for (;;) {
  if (fs.existsSync(path.join(dir, 'src/utils/loadEnv.ts'))) {
    dotenv.config({ path: path.join(dir, '.env') });
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
