import semver from 'semver';
import type { GeneratedPattern, TagConverter } from '../../types/patternTypes';
import { metaOf } from './shared';

// node-npm-requirement-raised: 環境述語(PatternKind=environment)を生成
// 要求下限 = post engines.node の semver 最小。npm は client 版を静的判別できず未対応
export const convertNodeNpmRequirementRaised: TagConverter = (input) => {
  const { candidate, engines } = input;
  const field = candidate.symbol.startsWith('engines.') ? candidate.symbol.slice('engines.'.length) : 'node';
  if (field !== 'node') return [];

  const min = engines?.post?.node ? semver.minVersion(engines.post.node) : null;
  if (!min) return [];

  const meta = metaOf(input);
  const pattern: GeneratedPattern = {
    ...meta, importForm: 'env#engines.node', calls: [],
    env: { kind: 'node-engine', field: 'engines.node', requiredMin: min.version },
  };
  return [pattern];
};
