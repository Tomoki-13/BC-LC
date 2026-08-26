//copy R-BC src/types/ModuleList.ts
export interface ModuleList {
  code: string;
  modulename: string;
  path: string;
}

//importAndPathで関数名ごと
export interface CallModuleAndFuncList {
  code: string;
  call_modulename: string;
  funcname: string;
  path: string;
}