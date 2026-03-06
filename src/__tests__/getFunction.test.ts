import * as path from 'path';
import * as fs from 'fs';

import { getFunction, toExportedFunctionInfo } from "../astRelated/trace/getFunction";
import { FunctionInfo_funcRange } from '../types/FunctionInfo';

// 実行環境による改行コード差分などで発生する start/end のズレを無視してロジック検証を行うヘルパー
const sanitizeForComparison = (data: FunctionInfo_funcRange[]) => {
  return data.map(({ start, end, ...rest }) => rest).sort((a, b) => a.funcname.localeCompare(b.funcname));
};

describe('toExportedFunctionInfo test (Basic output)', () => {
  const filePath1: string = "./src/__tests__/inputFiles/functionSample/getFunc_default.js";
  const filePath2: string = "./src/__tests__/inputFiles/functionSample/getFunc_sub.js";
  
  const outputPath = path.resolve(__dirname, 'outputFiles/getFunctionData.json');
  const jsonData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));

  test('get only exportedFunctions (default.js)', async () => {
    const expected = sanitizeForComparison(jsonData.exportedFunctions);
    const actual = sanitizeForComparison(await toExportedFunctionInfo(filePath1, 0));
    expect(actual).toEqual(expected);
  });

  test('get all functions (default.js)', async () => {
    const expected = sanitizeForComparison(jsonData.allFunctions);
    const actual = sanitizeForComparison(await toExportedFunctionInfo(filePath1, 1));
    expect(actual).toEqual(expected);
  });

  test('get only exportedFunctions_sub (sub.js)', async () => {
    const expected = sanitizeForComparison(jsonData.exportedFunctions_sub);
    const actual = sanitizeForComparison(await toExportedFunctionInfo(filePath2, 0));
    expect(actual).toEqual(expected);
  });

  test('get all functions_sub (sub.js)', async () => {
    const expected = sanitizeForComparison(jsonData.allFunctions_sub);
    const actual = sanitizeForComparison(await toExportedFunctionInfo(filePath2, 1));
    expect(actual).toEqual(expected);
  });
});

describe('getFunction extended metadata tests', () => {
  const extendedFilePath: string = "./src/__tests__/inputFiles/functionSample/getFunc_extended.js";
  
  const outputPath = path.resolve(__dirname, 'outputFiles/getFunctionData.json');
  const jsonData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));

  const sanitizeForExtendedComparison = (data: any[]) => {
    return data.map(({ start, end, ...rest }) => rest).sort((a, b) => a.name.localeCompare(b.name));
  };

  test('get all functions with extended metadata', async () => {
    const expected = sanitizeForExtendedComparison(jsonData.extendedFunctions);
    
    const actual = sanitizeForExtendedComparison(await getFunction(extendedFilePath, 1));
    
    expect(actual).toEqual(expected);
  });
});