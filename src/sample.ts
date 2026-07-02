// 動作確認用ランナー: サンプル(sample/libDiffSample)の pre/post で surface 抽出と diff を表示
// 実行: cd BC-LC/src && npx tsx sample.ts

import path from 'path';
import ApiSurface from './libDiff/apiSurface';
import DiffSurface from './libDiff/diffSurface';

(async () => {
  const dir = (v: string) => path.resolve(process.cwd(), '../sample/libDiffSample', v);
  const pre = await ApiSurface.buildApiSurface(dir('pre'), '1.0.0', 'v1.0.0');
  const post = await ApiSurface.buildApiSurface(dir('post'), '2.0.0', 'v2.0.0');

  const fmt = (s: any) => `${s.isAsync ? 'async ' : ''}${s.name}(${(s.params || []).join(',')}) @${s.filePath} ret=[${(s.returnExprs || []).join(' || ')}]`;
  console.log('=== PRE surface ===');
  pre.symbols.forEach((s: any) => console.log('  ' + fmt(s)));
  console.log('=== POST surface ===');
  post.symbols.forEach((s: any) => console.log('  ' + fmt(s)));

  console.log('=== LOSS CANDIDATES ===');
  for (const c of DiffSurface.diffSurface(pre, post, 'sample')) {
    console.log(`  ${c.symbol.padEnd(10)} ${c.tag.padEnd(20)} ${c.confidence.padEnd(10)} ${c.label}  | ${c.detail ?? ''}`);
  }
})();
