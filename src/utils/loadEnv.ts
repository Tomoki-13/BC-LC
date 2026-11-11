import path from 'path';
import dotenv from 'dotenv';

// BC-LC/.env を読む（実行したフォルダに関係なく同じファイル）。shell で export 済みの値は上書きしない
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
