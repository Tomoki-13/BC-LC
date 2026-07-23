# BC-LC (lib-api-checker)

P2: **ライブラリ情報起点**の後方互換性損失パターン生成（実装途上）。

メタリポ `BCPatternGen` 配下での利用を前提とし、入出力は親ディレクトリの共有ディレクトリを参照する。

---

## libDiff — バージョン前後差分から後方互換性の損失候補を検出

ライブラリの pre/post を比較し、**関数の削除・引数変化・返り値変化・同期/非同期化・deep-import 破壊・公開形変化**などを
ラベル付きで抽出する（`src/index.ts` + `src/libDiff/` + `src/core/`）。

### 実行（3コマンド）
```sh
make run-sample   # 全損失タグ網羅のサンプル(sample/testLib)で確認
make run-uuid     # uuid 3.4.0 → 7.0.0-beta.0
make run-globby   # globby 6.1.0 → 7.0.0
# 任意: cd src && npx tsx index.ts --pair <lib> <pre> <post>   /   --local <dir> <名前>   /   <lib>(npm全版)
```

### 出力（history + latest）
```
outputs/history/BC-LC/libDiff/<RUN_ID>/<lib>/   … 実行ごとにアーカイブ
outputs/latest/BC-LC/libDiff/<lib>/             … lib 単位で最新を蓄積
  surfaces/<cleanVer>.json          版ごとの export surface（name/params/returnExprs/isAsync/accessPath）
  pairs/<pre>__<post>.json          損失候補（symbol/tag/label/confidence/verdict/detail）
  summary.json                      tag/confidence/verdict 別の集計
```

### 損失候補の見方
- **confidence**: `structural`=構造的に確実 / `semantic`=要確認（本体差分等）
- **verdict**（機能1 judgeLoss）: `loss`=損失確定（structural）/ `review`=要確認（semantic）
- **tag**: `function-removed / arg-added / arg-removed / arg-reordered / return-changed / sync-to-async / deep-import-broken / export-style-changed / option-removed / node-npm-requirement-raised`
  - 引数の**単なるリネーム**（位置引数）は破壊的でないため検出しない（ノイズ低減）
  - `node-npm-requirement-raised`: `package.json` の `engines.node` / `engines.npm` の**必要下限が引き上げられた**場合（新規付与含む）。それ未満のランタイム利用者が install/実行で壊れる。下限の低下・制約撤廃は非検出

> 未実装: 機能2 `generatePattern`（P1 形式のパターン生成）。exportStyle/module-format 検出は TODO（`docs/DESIGN-P2.md`）。

---

## 評価パイプライン — ground_truth との突合で精度を測る

役割で3段に分けている。**重い検出は1回だけ**走らせ、その出力 `records.json` を採点・分析が共有して読む（単一パス）。

| 段 | 役割 | ソース | 出力先 | コスト |
|---|---|---|---|---|
| **A 事実生成** | 全ペアを検出（clone→surface→diff） | `evaluation/runDetection.ts` | `detection/records.json` | **重い**（唯一 clone/解析するパス）|
| **B 採点** | 事実を正解と突合し混同行列 | `evaluation/compare.ts` | `eval/` | 軽い（records を読むだけ）|
| **C 分析** | 特徴量の精査（FP源・ポリシー掃引・return内訳）| `analysis/*.ts` | `analysis/<tool>/` | 軽い（records を読むだけ）|
| **B' 比較** | 外部API絞り込み mode0/1/2/3 の精度比較 | `evaluation/scopeCompare.ts` | `eval/scope_compare.json` | **重い**（surface を別途作り直す）|

正解ラベル生成（`evaluation/groundTruth.ts`）が先頭に付く。`state`=クライアントテスト結果、`loss = state==='failure'`。

### 実行
```sh
make run            # A→B→C→scope を一括（index.ts だけで scope 含む全結果）
make detect         # A のみ: records.json を作り直す
make compare        # B のみ: 既存 records.json を再採点（検出しないので高速）
make tag-analysis   # C: タグ別 fail/succ（FPノイズ源）
make pair-tags      # C: 損失定義ポリシー掃引
make return-analysis# C: return-changed の内部兆候
make scope          # mode0/1/2/3 の精度比較だけ単独で（高コスト）
make show-result    # 直近の混同行列を表示
# N=5 で先頭5libのパイロット（detect / scope）: make detect N=5
```

`make run` は既存 latest を消さず上書き更新する（各出力は `mkdir -p` 相当で、消えるのは同名ファイルのみ）。

### 出力（`outputs/latest/BC-LC/`）
```
detection/
  records.json          全ペアの検出事実（status/reason/candidates[{tag,detail,confidence}]）＝B/Cの共通入力
eval/
  ground_truth.json     正解ラベル（npm_pkg/prev/updated/state/loss）
  compare_summary.json  混同行列・precision/recall/accuracy/f1・除外理由の集計
  evaluation.csv        評価できたペアごと（test_result/predicted_loss/category/tags/causes）
  excluded_pairs.csv    評価不能ペアと理由（ref未解決/clone失敗/surface空 等）
  label_distribution.csv タグ別 TP/FP/precision（Positive 判定の理由分布）
  compare_detail.csv    全ペアの素の判定（後方互換の列）
  scope_compare.json    mode0/1/2/3 の混同行列（make scope 実行時のみ）
analysis/
  tagAnalysis/tag_analysis.json     タグ/confidence 別 fail-succ（FPノイズ源）
  pairTags/pair_tags.json           ペア別タグ集合（掃引の入力）
  pairTags/policy_sweep.json        損失定義ポリシー別の混同行列
  returnAnalysis/return_analysis.json return-changed の兆候別内訳
audit/
  resolution_log.csv / run.log / run_summary.json   バージョン解決手段・警告・エラー
```

### ソース構成
```
src/evaluation/   A+B: 事実生成と採点
  groundTruth.ts    正解ラベル生成
  runDetection.ts   ★重い1パス: 全ペア検出 → records.json（＋audit）
  compare.ts        records → 混同行列・各CSV（採点）
  scopeCompare.ts   mode比較（surface 4回・別軸）
src/analysis/     C: records から派生する探索的分析（軽い）
  tagAnalysis.ts / pairTags.ts / returnAnalysis.ts
src/utils/evalShared.ts  共通基盤（パス定数/型/loadGroundTruth/loadRecords/computeMetrics 等）
```

---

## 調査（BC-sample）— 一時的な探索。本線 BC-LC と分離

恒久評価でない実験的調査はここに出す（`outputs/latest/BC-sample/<調査名>/`、履歴は `outputs/history/BC-sample/<timestamp>/<調査名>/`）。

### depImpact — 間接依存起因の見落とし（実装途上）

ライブラリ自身の API は不変でも、**依存の bump** が損失を運んでクライアントを壊すケース（例: globby 自身は不変だが依存 `glob` が major bump）を測る。

- `runDetection` が packument から pre/post の依存(`dependencies`+`peerDependencies`)の range 変化を `records.json` の `depChanges` に**別枠で**記録する（`candidates` と分離＝採点・FN判定・scope には不使用）
- `make dep-impact` が category 別に依存 major-bump 率を集計し、**FN（見逃し）と TN の率を比較**する
  - FN の major-bump 率が TN より十分高ければ「依存 bump は見落としを説明する識別力ある signal」→ 依存の再帰解析(Lv2)に進む価値あり。FN≈TN なら依存は主因でないと判断
  - 出力: `BC-sample/depImpact/fn_dep_correlation.json`（FN ペアで major-bump した依存名一覧つき）

---

## collectDataset — データセット収集

特定ライブラリの**更新後バージョン(target)** を指定すると、

1. **npm registry** から target の「一つ前(pre)」のバージョンを解決
   （pre = target より厳密に小さい公開版のうち最大。既定で target が安定版ならプレリリースは除外）
2. その **pre を使う（= まだ target に移行していない）クライアント**を GitHub code search で収集
   （後述の**品質条件**を満たすものだけ採用。**既存の収集データがあればそれを確認・加算**して規定数 COUNT に到達させる）
3. 採用クライアントを **clone**（`clonedata/codesearch_clientRepos/<lib>/`）
4. **ライブラリ本体の pre/post を clone** して、その間の変更差分(diff)を取得・保存

を行う。収集したデータセット（更新前後バージョン＋変更差分）を用いて、
後続（予定）で**静的解析により変更された関数を特定**する。

### クライアントの品質条件（採用基準）

無保守・実績の乏しいリポジトリを除外するため、以下を**すべて**満たすものだけを採用する
（`src/collectDataset/github/repoQuality.ts` の `DEFAULT_QUALITY` で調整可能）:

| 条件 | 既定値 | 意図 |
|---|---|---|
| スター数 | `>= 5` | 一定の利用実績 |
| 最終 push | **直近3年以内** | 開発が継続している |
| fork リポジトリ | **除外** | オリジナルの実装を対象にする |
| archived | **除外** | 開発停止プロジェクトを除く |

加えて、対象ライブラリを **dependencies / devDependencies に実際に宣言**し、その依存レンジが
**pre を満たし post（target）を満たさない**（＝まだ更新後に移行していない）ことを必須とする。

### 既存データの加算（再実行時）

`client_list.json` が既にある場合、その中身を読み込んで重複を除き、**規定数 COUNT の一部として加算**する。
不足分（`COUNT - 既存件数`）だけを新規に収集するため、再実行で件数を積み増せる。
clone も中身があるものはスキップする。

### 必要な環境変数

```sh
export GITHUB_TOKEN=ghp_xxx   # code search / contents API / clone に必須
```

（`.env` でも可。`dotenv` で読み込む）

### 実行

```sh
# メタリポルートから
make bclc-collect LIB=next VER=2.0.0 COUNT=5

# サンプル（uuid 8.0.0 のライブラリ pre/post ＋ クライアント3件を収集・クローン）
make bclc-sample            # = make collect LIB=uuid VER=8.0.0 COUNT=3

# BC-LC 直下から
make collect LIB=next VER=2.0.0 COUNT=5
make sample

# 直接
cd src && npx tsx collectDataset/index.ts uuid 8.0.0 3
```

### 出力

`../outputs/latest/BC-LC/collectDataset/<lib>@<post>/`

| ファイル | 内容 |
|---|---|
| `resolved_versions.json` | 解決した pre/post と候補バージョン一覧 |
| `client_list.json` | 採用クライアント（owner/repo・依存レンジ・dep種別・★/forks/最終push） |
| `client_names.json` | owner/repo のみの簡易リスト |
| `clone_clients_result.json` | クライアント clone 結果（cloned / reused / failed） |
| `lib_diff.json` | pre/post タグ・変更ファイル一覧・diff(.patch) パス |
| `<lib>_<pre>_to_<post>.patch` | JS/TS の unified diff 本体 |
| `summary.json` | 収集サマリ（品質条件・既存/新規件数を含む） |

- ライブラリ本体の clone 先: `../clonedata/lib_versions/<lib>/`
- クライアントの clone 先: `../clonedata/codesearch_clientRepos/<lib>/<owner>/<repo>/`

### 構成

```
src/collectDataset/
├── index.ts                  # エントリ（CONFIG / 引数で lib・ver・count）
├── types.ts
├── npm/registry.ts           # npm registry: バージョン解決・repo URL 取得
├── github/
│   ├── githubClient.ts       # 認証ヘッダ・sleep（GITHUB_TOKEN 統一）
│   ├── fetchDependencies.ts  # クライアント package.json の依存取得
│   ├── repoQuality.ts        # 品質条件（★/活動/fork/archived）の取得・判定
│   └── searchRepositories.ts # code search ＋ pre 利用 ＋ 品質フィルタ
├── filter/versionFilter.ts   # semver: pre を使い post 未満かの判定
└── lib/
    ├── cloneLibVersions.ts   # ライブラリ pre/post clone ＋ git diff
    └── cloneClients.ts       # 採用クライアントの clone
```

> 参照: クライアント収集の発想は
> [how-clients-use-the-library-version](https://github.com/Tomoki-13/how-clients-use-the-library-version)
> の `colllect_dateset` を基に、**バージョン絞り込み**を追加。clone は R-BC の `cloneRepoWithCommit` を参考にした。
