import fs from 'fs/promises';
import path from 'path';

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.cjs',
  '.mjs',
]);

const EXCLUDED_SUFFIXES = [
  '.min.js',
  '.dev.js',
  '.lib.js',
  '.lib.ts',
  '.bundle.js',
];

const EXCLUDED_FILENAMES = new Set([
  '.DS_Store',
]);

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
]);

const TEST_DIRECTORIES = new Set([
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'spec',
  'specs'
]);

const TEST_SUFFIXES = [
  '.test.',
  '.spec.'
];

export const getAllFiles = async (directoryPath: string): Promise<string[]> => {
  const allFiles: string[] = [];
  try {
    const files = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(directoryPath, file.name);

      if (file.isFile()) {
        if (isAnalyzableSourceFile(filePath) && !isTestPath(filePath)) {
          allFiles.push(filePath);
        }
      } else if (file.isDirectory()) {
        if (!isExcludedDirectory(filePath) && !TEST_DIRECTORIES.has(file.name)) {
          const subFiles = await getAllFiles(filePath);
          allFiles.push(...subFiles);
        }
      }
    }
  } catch (err) {
    console.error('Error reading directory:', err);
    throw err;
  }

  return allFiles;
};

export const getAllTestFiles = async (directoryPath: string): Promise<string[]> => {
  const allFiles: string[] = [];
  try {
    const files = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(directoryPath, file.name);

      if (file.isFile()) {
        if (isAnalyzableSourceFile(filePath) && isTestPath(filePath)) {
          allFiles.push(filePath);
        }
      } else if (file.isDirectory()) {
        if (!isExcludedDirectory(filePath)) {
          const subFiles = await getAllTestFiles(filePath);
          allFiles.push(...subFiles);
        }
      }
    }
  } catch (err) {
    console.error('Error reading directory:', err);
    throw err;
  }

  return allFiles;
};

export const getAllFilesRecursively = async (targetPath: string): Promise<string[]> => {
  const results: string[] = [];
  const stats = await fs.stat(targetPath);
  if (stats.isFile()) {
    return [targetPath];
  }
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;

    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      const nestedFiles = await getAllFilesRecursively(fullPath);
      results.push(...nestedFiles);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
};

const isAnalyzableSourceFile = (filePath: string): boolean => {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);

  if (!SOURCE_EXTENSIONS.has(ext)) {
    return false;
  }

  if (EXCLUDED_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
    return false;
  }

  if (EXCLUDED_FILENAMES.has(fileName)) {
    return false;
  }

  return true;
};

const isTestPath = (filePath: string): boolean => {
  const fileName = path.basename(filePath);
  const segments = filePath.split(path.sep);

  const isInTestDir = segments.some((segment) => TEST_DIRECTORIES.has(segment));
  const hasTestSuffix = TEST_SUFFIXES.some((suffix) => fileName.includes(suffix));

  return isInTestDir || hasTestSuffix;
};

const isExcludedDirectory = (dirPath: string): boolean => {
  const segments = dirPath.split(path.sep);
  return segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment));
};