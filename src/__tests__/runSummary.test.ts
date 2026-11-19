import { splitCsvLine } from '../evaluation/runSummary';

describe('runSummary: CSV の1行をセルに分ける', () => {
  test('引用符・カンマ・二重の引用符', () => {
    expect(splitCsvLine('a,"b,c","d ""e""",')).toEqual(['a', 'b,c', 'd "e"', '']);
  });
  test('引用符の無い行', () => {
    expect(splitCsvLine('g1-failureClient,uuid,3.4.0,7.0.0-beta.0,10,9')).toEqual(['g1-failureClient', 'uuid', '3.4.0', '7.0.0-beta.0', '10', '9']);
  });
});
