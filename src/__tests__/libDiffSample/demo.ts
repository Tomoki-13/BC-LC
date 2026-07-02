// 実行: cd BC-LC/src && npx tsx __tests__/libDiffSample/demo.ts
import path from 'path';
import ApiSurface from '../../libDiff/apiSurface';
import DiffSurface from '../../libDiff/diffSurface';

(async () => {
  const dir = (v: string) => path.resolve(process.cwd(), '../sample/libDiffSample', v);
  const pre = await ApiSurface.buildApiSurface(dir('pre'), '1.0.0', 'v1.0.0');
  const post = await ApiSurface.buildApiSurface(dir('post'), '2.0.0', 'v2.0.0');

  console.log('=== PRE surface ===');
  console.log(JSON.stringify(pre.symbols, null, 2));
  console.log('=== POST surface ===');
  console.log(JSON.stringify(post.symbols, null, 2));
  console.log('=== LOSS CANDIDATES (diffSurface) ===');
  console.log(JSON.stringify(DiffSurface.diffSurface(pre, post, 'sample'), null, 2));
})();
