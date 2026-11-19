import { detectOnlyLabel } from '../clientDetect/runClientDetect';

describe('検出だけの実行の出力フォルダ名（パターンの出所）', () => {
  test('history の make run のパターン → 実行のフォルダ名', () => {
    expect(detectOnlyLabel('../../outputs/history/BC-LC/2026-11-16-11-51-17_scope-all_detect-config/generated_patterns/all_patterns.json'))
      .toBe('2026-11-16-11-51-17_scope-all_detect-config');
  });
  test('latest のモードのパターン → latest_<モード>', () => {
    expect(detectOnlyLabel('../../outputs/latest/BC-LC/scope-all_detect-config/generated_patterns/all_patterns.json'))
      .toBe('latest_scope-all_detect-config');
  });
  test('1 ライブラリの実行（libDiff）のパターン → libDiff_<lib>', () => {
    expect(detectOnlyLabel('../../outputs/latest/BC-LC/libDiff/uuid/patterns')).toBe('libDiff_uuid');
  });
  test('それ以外 → ファイル名', () => {
    expect(detectOnlyLabel('/somewhere/my_patterns.json')).toBe('my_patterns');
  });
});
