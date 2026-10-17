import type { TagConverter } from '../../types/patternTypes';
import { anyRootImportBindings, subpathBindings, subpathDirBindings, subpathExceptBindings } from '../patternRegex';
import { metaOf } from './shared';

// exports-restricted: package.json exports で読めなくなった読み込みを binding のみで検出（読み込んだ時点で失敗）
//   (exports) = exports 新設: 公開サブパス以外への deep import すべて
//   (require) = 本体を require で読めなくなった: require('lib')
//   それ以外  = exports から消えたサブパス（'x/*' は x/ 配下すべて）
export const convertExportsRestricted: TagConverter = (input) => {
  const meta = metaOf(input);
  const { symbol, exportsAllowed } = input.candidate;
  const bindings = symbol === '(exports)'
    ? subpathExceptBindings(meta.libName, exportsAllowed ?? ['.'])
    : symbol === '(require)'
      ? anyRootImportBindings(meta.libName).filter(b => b.form === 'require-any')
      : symbol.endsWith('/*')
        ? subpathDirBindings(meta.libName, symbol.slice(0, -2))
        : subpathBindings(meta.libName, symbol);
  return bindings.map(b => ({ ...meta, importForm: `${b.form}:${symbol}`, calls: [b.call] }));
};
