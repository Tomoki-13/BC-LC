export interface FunctionInfo_funcRange {
  funcname: string;
  arg: string[];
  filePath: string;
  start: number | null | undefined;
  end: number | null | undefined;
}

export interface FunctionMetaInfo {
  name: string;                        // 関数の名前（ASTノードの識別子、またはエクスポート名）
  isExported: boolean;                 // 外部にエクスポートされている関数かどうか（true/false）
  arg: string[];                       // 引数の文字列表現の配列（例: ["a", "b = 1", "...rest"]）
  filePath: string;                    // 関数が定義されているファイルの相対または絶対パス
  start: number | null | undefined;    // ファイル内での関数開始位置（ASTの文字インデックス）
  end: number | null | undefined;      // ファイル内での関数終了位置（ASTの文字インデックス）
}

export interface ExtendedFunctionMetaInfo extends FunctionMetaInfo {
  isPropertyFunction?: boolean;        // オブジェクトのプロパティとして定義された関数かどうか
  propertyPath?: string;               // ネストされたオブジェクト内でのアクセスパス（例: "mathUtils.divide"）
  isInstanceMethod?: boolean;          // クラスのメソッド、またはプロトタイプに代入された関数かどうか
  prototypeObj?: string;               // メソッドが属しているプロトタイプの名前（例: "Calculator.prototype"）
  isPotentialPrototype?: boolean;      // エイリアス解決待ち状態の仮プロトタイプかどうか（例: P.method = ... の "P"）
  returnExprs?: string[];              // 関数の return 文で返却されている式をそのまま文字列化した配列
}

export interface ModuleExportProperty {
  property_name: string;
  right_func: string;
}