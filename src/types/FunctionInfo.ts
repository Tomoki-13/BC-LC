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

// export の束縛形態（apiSurface / diffSurface と同じ語彙）
export type ExportStyleTag =
  | 'cjs-module-default' | 'cjs-property'
  | 'esm-named' | 'esm-default' | 'esm-reexport' | 'unknown';
export type SymbolKindTag = 'function' | 'class' | 'value' | 'getter' | 'unknown';

export interface ExtendedFunctionMetaInfo extends FunctionMetaInfo {
  isPropertyFunction?: boolean;        // オブジェクトのプロパティとして定義された関数かどうか
  propertyPath?: string;               // ネストされたオブジェクト内でのアクセスパス（例: "mathUtils.divide"）
  isInstanceMethod?: boolean;          // クラスのメソッド、またはプロトタイプに代入された関数かどうか
  prototypeObj?: string;               // メソッドが属しているプロトタイプの名前（例: "Calculator.prototype"）
  isPotentialPrototype?: boolean;      // エイリアス解決待ち状態の仮プロトタイプかどうか（例: P.method = ... の "P"）
  returnExprs?: string[];              // 関数の return 文で返却されている式をそのまま文字列化した配列
  isAsync?: boolean;                   // async 関数か（await 要否の変化検出に使用）
  optionKeys?: string[];               // 消費する options オブジェクトのキー（分割代入 / opts.key 読み取り）
  exportStyle?: ExportStyleTag;        // export の束縛形態（cjs/esm・named/default/property）
  kind?: SymbolKindTag;                // シンボル種別（class 検出）
}

export interface ModuleExportProperty {
  property_name: string;
  right_func: string;
}