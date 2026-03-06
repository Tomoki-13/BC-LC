/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    "<rootDir>/src/__tests__/**/*.ts",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/src/__tests__/inputFiles/",
    "/src/__tests__/outputFiles/",
  ],
  modulePathIgnorePatterns: [
  ],
};