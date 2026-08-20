import type { ExtractFunctionCallsResult } from '../types/ExtractFunctionCallsResult';

// R-BC 準拠の正規表現部品（stored 形式）
//   クォート抽象化・変数名キャプチャ・チェーン抑止までを埋め込み、括弧のエスケープは照合直前の別段(patternToScript 相当)で行う
//   ＝ failure_patternList.json と同じ段階の文字列を生成し、R-BC の照合器にそのまま渡せるようにする
const QUOTE = "[\"'`]";        // ' " ` を等価に扱う（import 記法の寛容化）
const CHAIN_GUARD = '[^.]*$';  // 後続の .method チェーンを許さない（R-BC checkDot 準拠）

/** 正規表現メタ文字をエスケープ（ライブラリ名・シンボル名の埋め込み用）。入力: 生文字列 / 出力: エスケープ済み */
// 例: "my-lib.js" -> "my\\-lib\\.js"
export function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 生成側の呼び出し要素を作る（client 由来の file/line/型情報は無いので空）。入力: 正規表現文字列 / 出力: ExtractFunctionCallsResult */
export function makeCall(regex: string): ExtractFunctionCallsResult {
  return { FunctionCallCode: regex, filePath: '', line: 0, argTypes: [], argContexts: [] };
}

/** import 形1つ分（form=どの記法か・call=その binding を表す正規表現要素） */
export interface BindingPart {
  form: string;
  call: ExtractFunctionCallsResult;
}

/**
 * ライブラリを「オブジェクトに束縛」する import 形（後で variable1.method で使う系）
 * 入力: libName / 出力: {form, binding}[]（cjs-require / esm-default / esm-namespace）
 */
export function objectBindings(libName: string): BindingPart[] {
  const lib = escapeLiteral(libName);
  const bound = '(?<variable1>[\\w-]+)';
  return [
    { form: 'cjs-require',   call: makeCall(`${bound} = require(${QUOTE}${lib}${QUOTE})${CHAIN_GUARD}`) },   // 例: const v1 = require('lib')
    { form: 'esm-default',   call: makeCall(`import ${bound} from ${QUOTE}${lib}${QUOTE}${CHAIN_GUARD}`) },   // 例: import v1 from 'lib'
    { form: 'esm-namespace', call: makeCall(`import \\* as ${bound} from ${QUOTE}${lib}${QUOTE}${CHAIN_GUARD}`) }, // 例: import * as v1 from 'lib'
  ];
}

/**
 * ライブラリから「名前 name を直接束縛」する import 形（後で name(...) 直呼びする系）
 * 入力: libName / name / 出力: {form, binding}[]（esm-named / cjs-destructure。他名の混在・改行を寛容に許す）
 */
export function namedBindings(libName: string, name: string): BindingPart[] {
  const lib = escapeLiteral(libName);
  const target = escapeLiteral(name);
  return [
    { form: 'esm-named',       call: makeCall(`import \\{[^}]*\\b${target}\\b[^}]*\\} from ${QUOTE}${lib}${QUOTE}${CHAIN_GUARD}`) }, // 例: import { name } from 'lib'
    { form: 'cjs-destructure', call: makeCall(`\\{[^}]*\\b${target}\\b[^}]*\\} = require(${QUOTE}${lib}${QUOTE})${CHAIN_GUARD}`) }, // 例: const { name } = require('lib')
  ];
}

/**
 * サブパス lib/subpath を import する形（module-removed 検出用）。入力: libName / subpath / 出力: {form, binding}[]
 *   消えたサブパスは import した時点で解決失敗するので、どの記法でも binding のみで足りる
 */
export function subpathBindings(libName: string, subpath: string): BindingPart[] {
  const spec = escapeLiteral(`${libName}/${subpath}`);
  const bound = '(?<variable1>[\\w-]+)';
  return [
    { form: 'cjs-require-subpath',   call: makeCall(`${bound} = require(${QUOTE}${spec}${QUOTE})${CHAIN_GUARD}`) },   // 例: const v1 = require('lib/sub')
    { form: 'esm-default-subpath',   call: makeCall(`import ${bound} from ${QUOTE}${spec}${QUOTE}${CHAIN_GUARD}`) },   // 例: import v1 from 'lib/sub'
    { form: 'esm-named-subpath',     call: makeCall(`import \\{[^}]*\\} from ${QUOTE}${spec}${QUOTE}${CHAIN_GUARD}`) }, // 例: import { foo } from 'lib/sub'
    { form: 'esm-namespace-subpath', call: makeCall(`import \\* as ${bound} from ${QUOTE}${spec}${QUOTE}${CHAIN_GUARD}`) }, // 例: import * as v1 from 'lib/sub'
    { form: 'esm-bare-subpath',      call: makeCall(`import ${QUOTE}${spec}${QUOTE}${CHAIN_GUARD}`) },                 // 例: import 'lib/sub'
  ];
}

// 呼び出しの引数部（数不問で寛容）＋チェーン抑止。ARGS=`[^)]*` は括弧内のドット/カンマを許すので `sync(['*.js'])` も取りこぼさない
const CALL_TAIL = `([^)]*)${CHAIN_GUARD}`;

/**
 * 別名付きの名前束縛（import { NAME as v1 } / const { NAME: v1 } = require）。usage は捕捉した variable1 を参照
 * 入力: libName / name / 出力: {form, binding}[]（esm-named-alias / cjs-destructure-alias）
 */
export function namedAliasBindings(libName: string, name: string): BindingPart[] {
  const lib = escapeLiteral(libName);
  const target = escapeLiteral(name);
  const bound = '(?<variable1>[\\w-]+)';
  return [
    { form: 'esm-named-alias',       call: makeCall(`import \\{[^}]*\\b${target}\\s+as\\s+${bound}[^}]*\\} from ${QUOTE}${lib}${QUOTE}${CHAIN_GUARD}`) }, // 例: import { name as v1 } from 'lib'
    { form: 'cjs-destructure-alias', call: makeCall(`\\{[^}]*\\b${target}\\s*:\\s*${bound}[^}]*\\} = require(${QUOTE}${lib}${QUOTE})${CHAIN_GUARD}`) }, // 例: const { name: v1 } = require('lib')
  ];
}

/** variable1 のメンバ name を参照する使用（呼び出しに限らない＝削除された関数/値の参照検出）。入力: name / 出力: usage 要素 */
// 例: v1.name
export function memberReference(name: string): ExtractFunctionCallsResult {
  return makeCall(`\\bvariable1\\.${escapeLiteral(name)}\\b`);
}

/** 捕捉した変数(variable1)そのものを参照（default 束縛の usage）。出力: usage 要素 */
// 例: v1
export function capturedReference(): ExtractFunctionCallsResult {
  return makeCall('\\bvariable1\\b');
}

/** transpile 後の default 相互運用の参照: variable1.default。出力: usage 要素 */
// 例: v1.default
export function interopDefaultReference(): ExtractFunctionCallsResult {
  return makeCall('\\bvariable1\\.default\\b');
}

/** 束縛を直接呼ぶ使用（default export が関数そのもの）: variable1(...)。出力: usage 要素 */
// 例: v1(arg)
export function directCall(): ExtractFunctionCallsResult {
  return makeCall(`\\bvariable1${CALL_TAIL}`);
}

/** new で呼ぶ使用（default export がクラス）: new variable1(...)。出力: usage 要素 */
// 例: new v1(arg)
export function newCall(): ExtractFunctionCallsResult {
  return makeCall(`new variable1${CALL_TAIL}`);
}

/** transpile 後の default 相互運用の呼び出し: variable1.default(...)。出力: usage 要素 */
// 例: v1.default(arg)
export function interopDefaultCall(): ExtractFunctionCallsResult {
  return makeCall(`\\bvariable1\\.default${CALL_TAIL}`);
}

/** variable1 のメンバ method を呼ぶ使用: variable1.method(...)。入力: method / 出力: usage 要素 */
// 例: v1.method(arg)
export function memberCall(method: string): ExtractFunctionCallsResult {
  return makeCall(`\\bvariable1\\.${escapeLiteral(method)}${CALL_TAIL}`);
}

/** 名前 name を直接呼ぶ使用: name(...)（named import 由来）。入力: name / 出力: usage 要素 */
// 例: name(arg)
export function namedCall(name: string): ExtractFunctionCallsResult {
  return makeCall(`\\b${escapeLiteral(name)}${CALL_TAIL}`);
}

// 呼び出し引数の中に特定キーが現れる（option-removed 用）。ARGS 内に \bkey\b を要求
const callWithKey = (key: string): string => `([^)]*\\b${escapeLiteral(key)}\\b[^)]*)${CHAIN_GUARD}`;

/** variable1.method(... key ...) の呼び出し（削除された option キーを渡すクライアント検出）。入力: method / key */
export function memberUsageWithKey(method: string, key: string): ExtractFunctionCallsResult {
  return makeCall(`\\bvariable1\\.${escapeLiteral(method)}${callWithKey(key)}`);
}

/** name(... key ...) の直呼び出し（named import 由来 + 削除された option キー）。入力: name / key */
export function directUsageWithKey(name: string, key: string): ExtractFunctionCallsResult {
  return makeCall(`\\b${escapeLiteral(name)}${callWithKey(key)}`);
}