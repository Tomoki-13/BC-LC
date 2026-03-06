import { promises as fsPromises } from 'fs';
import { createAstFromFile } from './createAstFromFile';

export const checkAst = async (filePath: string): Promise<boolean> => {
  try {
    if (filePath.endsWith('.js') || filePath.endsWith('.ts')) {
      const fileContent: string = await fsPromises.readFile(filePath, 'utf8');
      const parsed = createAstFromFile(filePath, fileContent);
      if (parsed) {
        return true;
      }
    }
  } catch (error) {
    // console.log(`AST creation not possible: ${filePath}`);
    console.log(error);
    return false;
  }
  return false;
}

