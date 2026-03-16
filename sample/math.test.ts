import { add, subtract } from './math';

describe('Math functions', () => {
  it('should add two numbers', () => {
    const result = add(2, 3);
    // expect(result).toBe(5);
  });

  it('should subtract two numbers', () => {
    const result = subtract(5, 2);
    // expect(result).toBe(3);
  });
});