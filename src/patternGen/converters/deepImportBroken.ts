import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import { subpathBindings } from '../patternRegex';
import { metaOf } from './shared';

// 移動前ファイルパスから公開サブパスの手がかりを作る（拡張子・先頭のビルド root・末尾 /index を除く）
function deriveSubpath(filePath: string): string {
  return filePath
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/^(src|lib|dist|build|source|esm|cjs)\//, '')
    .replace(/\/index$/, '');
}

// deep-import-broken: 移動した旧サブパスの deep import を binding のみで検出
// サブパスの手がかりは移動前パスと symbol 名の両方
export const convertDeepImportBroken: TagConverter = (input) => {
  const meta = metaOf(input);
  const subpaths = new Set<string>();
  const fromFile = deriveSubpath(input.preSymbol.filePath);
  if (fromFile) subpaths.add(fromFile);
  subpaths.add(input.preSymbol.name);

  const out: GeneratedPattern[] = [];
  for (const subpath of subpaths) {
    for (const binding of subpathBindings(meta.libName, subpath)) {
      out.push({ ...meta, importForm: `${binding.form}:${subpath}`, calls: [binding.call] });
    }
  }
  return out;
};
