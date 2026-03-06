import fs from 'fs';

import { ModuleList, CallModuleAndFuncList } from '../types/ModuleList';
import { funcNameIdentifiers } from './funcNameIdentifiers';

// 呼び出したモジュール，ファイル，ライブラリ名を取得
// mode = 0 : CallModuleAndFuncList[]
// mode = 1 : ModuleList[]
export const getImportAndPath = (filePath: string, mode: number = 0): CallModuleAndFuncList[] | ModuleList[] => {
  const code = fs.readFileSync(filePath, 'utf8');
  const result: ModuleList[] = [];
  const importRegex = /from\s+['"`](.*?)['"`]/;
  const requireRegex = /require\(['"`](.*?)['"`]\)/;
  const lines = code.split('\n').filter((line) => line.length < 200);
  const importLines: string[] = lines.filter((line) => /import|require/.test(line) && !/^\s*\/\//.test(line));

  //行単位でimport , requireを分類
  for (const line of importLines) {
    if (/import|require/.test(line) && !/^\s*\/\//.test(line)) {
      const importMatch = line.match(importRegex);
      if (importMatch && importMatch[1].length > 0) {
        result.push({ code: line.trim(), modulename: importMatch[1], path: filePath });
      } else {
        const requireMatch = line.match(requireRegex);
        if (requireMatch && requireMatch[1].length > 0) {
          result.push({ code: line.trim(), modulename: requireMatch[1], path: filePath });
        }
      }
    }
  }
  if (mode === 1) {
    return result;
  }
  return get_perFunc(result);
};

//ModuleList[]を関数単位にインポートしたソフトウェア名と関数名の情報を追加
const get_perFunc = (moduleList: ModuleList[]): CallModuleAndFuncList[] => {
  const result: CallModuleAndFuncList[] = [];

  moduleList.forEach((moduleInfo) => {
    try {
      const funcNames = funcNameIdentifiers(moduleInfo.code, moduleInfo.modulename);
      funcNames.forEach((funcName) => {
        result.push({ code: moduleInfo.code, call_modulename: moduleInfo.modulename, funcname: funcName, path: moduleInfo.path });
      });
    } catch (error) {
      console.log("moduleInfo.code error:", moduleInfo.code);
      console.log("get_perFunc error:", moduleInfo.modulename);
    }
  });
  return result;
};