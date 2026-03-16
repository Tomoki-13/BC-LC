export const add = (a: number, b: number): number => {
  return a + b;
};

export const subtract = (a: number, b: number): number => {
  return a - b;
};

// エクスポートされていない内部関数（テストからは直接インポートされない）
const multiply = (a: number, b: number): number => {
  return a * b;
};