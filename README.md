# BC-LC (lib-api-checker)

P2: **ライブラリ情報起点**の後方互換性損失パターン生成（実装途上）。

メタリポ `BCPatternGen` 配下での利用を前提とし、入出力は親ディレクトリの共有ディレクトリを参照する。

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
