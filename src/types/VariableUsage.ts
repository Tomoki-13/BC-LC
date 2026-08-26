//copy R-BC src/types/VariableUsage.ts
export interface ScopeRange {
  start: number;
  end: number;
}

export interface VariableUsage {
  code: string[];
  varScopeStart: number;
  varScopeEnd: number;
}
