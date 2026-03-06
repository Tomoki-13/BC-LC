import * as fs from 'fs';
import * as path from 'path';

const createOutputDirectory = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    // console.log(dirPath);
  }
};

const getUniqueOutputPath = (baseDir: string, baseName: string, name: string): string => {
  let outputPath = path.join(baseDir, `${baseName}_${name}.json`);
  if (fs.existsSync(outputPath)) {
    const now = new Date();
    const date = formatDateTime(now);
    outputPath = path.join(baseDir, `${baseName}_${name}_${date}.json`);
  }
  return outputPath;
};

function formatDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

function extractMiddleFlexible(s: string, prefix = "repos_"): string | null {
  const pattern = new RegExp(`^${prefix}(.+?)_[^_]+$`);
  const match = s.match(pattern);
  return match ? match[1] : null;
}

export default {
  createOutputDirectory,
  getUniqueOutputPath,
  formatDateTime,
  extractMiddleFlexible
};