//copy R-BC src/utils/extractImportLines.ts
//importの特定パターンの収集
export const extractImportLinesFull = (code: string): string[] => {
  const lines = code.split('\n');
  const importAndRequireLines: string[] = lines.filter(line => /import.*from|=\s*require/.test(line) && !/^\s*\/\//.test(line));
  let result = importAndRequireLines.filter(line => line.length < 200);
  return result;
}

export const extractImportLines = (code: string, libName: string): string[] => {
  const lines = code.split('\n');
  let importAndRequireLines: string[] = lines.filter(line => /import|require/.test(line) && !/^\s*\/\//.test(line));
  //("|')と(?=["'/])前後に不適切なものがつかないようにするため
  //const resultimportAndRequireLines:string[] = importAndRequireLines.filter(line => new RegExp(`("|')${libName}(?=["'/])`).test(line));
  const resultimportAndRequireLines: string[] = importAndRequireLines.filter(line => new RegExp(`("|'|\\\`)${libName}(?=["'/\\\`])`).test(line));
  return resultimportAndRequireLines;
}
