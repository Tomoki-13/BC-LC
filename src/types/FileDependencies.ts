export interface DependencyInfo {
  dep_filepath: string; // メソッド，インタフェースが定義されているファイル
  functions: string[];
}
//あるファイルが呼び出している依存関係
export interface OutboundFileDependencies {
  filepath: string; // メソッドを定義しているファイル
  dependence: DependencyInfo[]; // メソッドを使用しているファイルとそのメソッド
}

//あるファイルが呼び出されている依存関係
export interface InboundFunctionDependencies {
  funcNameInFilepath: string; // メソッド名
  filepath: string; // メソッド,インターフェースを定義しているファイル
  dependence: DependencyInfo[]; // メソッドを使用しているファイルとそのメソッド
}
