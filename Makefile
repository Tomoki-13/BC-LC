# ==============================================================
# BC-LC Makefile
# ==============================================================
# P2: ライブラリ情報起点のパターン生成（実装途上）
# 現状は collectDataset（データセット収集）を提供する。
# ==============================================================

SHELL  := /bin/bash
SRCDIR := src
TSX    := npx tsx

# 実行ログ: 全出力（標準出力・標準エラー）を <ログ先>/run.log に残す。プロセスが落ちても最後の出力（OOM のトレース等）まで残る
#   使い方: $(call run_logged,<ログ先>,<src 下で実行するコマンド>)
#   ログ先は history/<ラベル>/<RUN_ID>[-目印]/logs。BCPG_RUN_ID で TS 側の history ディレクトリと同じ日時にそろえ、
#   TS 側（utils/runLog.ts）は同じ場所に errors.jsonl / progress.json / run_info.json を書く
RUN_ID := $(shell date +%Y-%m-%d-%H-%M-%S)
HIST   := ../outputs/history
HEAP   := NODE_OPTIONS=--max-old-space-size=8192
run_logged = mkdir -p $(1) && set -o pipefail && cd $(SRCDIR) && BCPG_RUN_ID=$(RUN_ID) BCLC_LOG_DIR=$(abspath $(1)) BCLC_SCOPE=$(SCOPE) BCLC_DETECT=$(DETECT) $(2) 2>&1 | tee $(abspath $(1))/run.log

# collectDataset の引数（コマンドラインで上書き可能）
#   make collect LIB=next VER=2.0.0 COUNT=5
LIB   ?= next
VER   ?= 2.0.0
COUNT ?= 5

.PHONY: install collect sample run-sample run-uuid run-globby sample-uuid \
        run detect compare setup prepare-clients clone-clients check-clients clone-clients-sample client-detect scope tag-analysis pair-tags return-analysis captured-symbols dep-impact show-result help run-8lib build-targets run-all-pairs

# 分析系のパイロット件数（先頭 N lib だけ。空なら全件）
#   make scope N=5
N ?=

# 実行モード（make run の結果はモードごとのフォルダ latest/BC-LC/<VARIANT>/・history/BC-LC/<日時>_<VARIANT>/ に出る）
#   SCOPE = 損失判定・パターン生成で外部 API とみなす範囲（空なら all）
#     all     : 全 export
#     doc     : リポジトリ内の全 .md（README・CHANGELOG・docs/ 以下など）の本文に名前が出てくる export
#     test    : テストファイルが import して使う export
#     doctest : doc と test のどちらかに当たる export
#     package.json 由来の損失（engines・type・files・exports）はどの範囲でも残る
#   DETECT = クライアント検出の粒度（積み上げ式・空なら 2 = config）。run / client-detect / run-8lib で効く
#     1 または code   : ソースコードのパターンだけ
#     2 または config : ＋設定ファイル（CI 設定・engines・.nvmrc から推定した Node のバージョン）  ← 標準
#     3 または pkg    : ＋package.json の依存に直接書いてある（コードで読み込んでいないクライアント）
#     4 または all    : ＋ロックファイル・registry で依存の依存（2段まで）に届く
#     依存の経路は 3・4 のときだけたどる（1・2 では package.json・ロックファイルを読まず npm registry にも接続しない）。結果は clients_detail.csv の library_link 列
#   例: make run SCOPE=doc  /  make run DETECT=all  /  make run SCOPE=test DETECT=code
SCOPE  ?= all
DETECT ?= config
DETECT_NAME := $(or $(filter code config pkg all,$(DETECT)),$(word $(firstword $(filter 1 2 3 4,$(DETECT)) 0),code config pkg all))
VARIANT := scope-$(SCOPE)_detect-$(DETECT_NAME)
# 個別のコマンド（compare・tag-analysis 等）も同じモードのフォルダを読み書きするよう、全レシピに渡す
export BCLC_SCOPE  := $(SCOPE)
export BCLC_DETECT := $(DETECT)

# client-detect（単体）が参照するパターン（ファイル or ディレクトリ。空なら既定の latest/BC-LC/<VARIANT>/work/patterns/patterns.json）
#   make client-detect PATTERNS=../outputs/history/BC-LC/<日時>_<VARIANT>/work/patterns/patterns.json
PATTERNS ?=

# ---------------------------------------------------------------
install: ## 依存パッケージのインストール
	npm install

# ---------------------------------------------------------------
# データセット収集
#   1. npm registry から target の「一つ前」を解決
#   2. その pre を使うクライアントを COUNT 件収集
#   3. ライブラリ本体 pre/post を clone して差分を保存
# 要 GITHUB_TOKEN（code search / contents API / clone 用）
# 出力: ../outputs/latest/BC-LC/collectDataset/<lib>@<post>/
# ---------------------------------------------------------------
collect: ## データセット収集 (LIB / VER / COUNT で指定)
	cd $(SRCDIR) && $(TSX) collectDataset/index.ts $(LIB) $(VER) $(COUNT)

# サンプル: uuid 8.0.0 のライブラリ pre/post とクライアント3件を収集・クローン
sample: ## サンプル収集 (uuid 8.0.0, クライアント3件)
	cd $(SRCDIR) && $(TSX) collectDataset/index.ts uuid 8.0.0 3

# ---------------------------------------------------------------
# libDiff: バージョン前後を比較して後方互換性の損失候補を検出
# 出力: ../outputs/latest/BC-LC/libDiff/<lib>/pairs/<pre>__<post>.json
# ---------------------------------------------------------------
run-sample: ## 損失検出をサンプルライブラリ(sample/testLib)で実行（全タグ網羅）
	cd $(SRCDIR) && $(TSX) index.ts --local ../sample/testLib testLib

run-uuid: ## 損失検出を uuid 3.4.0 → 7.0.0-beta.0 で実行
	cd $(SRCDIR) && $(TSX) index.ts --pair uuid 3.4.0 7.0.0-beta.0

run-globby: ## 損失検出を globby 6.1.0 → 7.0.0 で実行
	cd $(SRCDIR) && $(TSX) index.ts --pair globby 6.1.0 7.0.0

run-8lib: ## targets.json の8版ペアで 判定→生成→検出 を一括 → BC-LC-8lib（patterns と client-detect・history は <日時>-8lib・ログは同 logs/）
	$(call run_logged,$(HIST)/BC-LC-8lib/$(RUN_ID)-8lib/logs,$(HEAP) $(TSX) 8-library.ts --detect)

build-targets: ## proposal_result の記録(prev,updated)ペアから datasets/targets.all.json を生成（setup 段）
	$(call run_logged,$(HIST)/setup/$(RUN_ID)-build-targets/logs,$(TSX) setup/buildTargets.ts)

run-all-pairs: ## 記録ペア全件(targets.all.json)で pattern 生成 → BC-LC-all（history は <日時>-all・要 build-targets）
	$(call run_logged,$(HIST)/BC-LC-all/$(RUN_ID)-all/logs,TARGETS=../../datasets/targets.all.json RUN_LABEL=BC-LC-all RUN_TAG=all $(TSX) 8-library.ts)

sample-uuid: ## uuid 3.4.0→8.0.0-beta.0 の1ペアだけ詳細出力（surface/losses/patterns/pkg差分）→ sample/
	cd $(SRCDIR) && $(TSX) runSample.ts

# ---------------------------------------------------------------
# 評価（詳細は README.md「評価パイプライン」）
#   run     : フルパイプライン。検出(重い1パス)→採点→分析3種を一括
#   detect  : 検出のみ（records.json だけ作り直す）
#   compare : 採点のみ（既存 records.json を読み直して再採点。高速）
# ---------------------------------------------------------------
run: ## フルパイプライン（正解生成→判定+生成→採点→分析→scope→client-detect）→ latest/BC-LC/<VARIANT>/・history/BC-LC/<日時>_<VARIANT>/。SCOPE=・DETECT= で実行モード
	$(call run_logged,$(HIST)/BC-LC/$(RUN_ID)_$(VARIANT)/logs,$(HEAP) $(TSX) index.ts)

detect: ## 判定+生成のみ → latest/BC-LC/<VARIANT>/work/{library-detect,patterns}/（＋ results/extraction-coverage/・ログは history/BC-LC/<日時>_<VARIANT>-detect/logs）
	$(call run_logged,$(HIST)/BC-LC/$(RUN_ID)_$(VARIANT)-detect/logs,$(HEAP) $(TSX) evaluation/runDetection.ts $(N))

compare: ## 採点のみ（records.json を読み直す。検出はしない）→ latest/BC-LC/<VARIANT>/results/loss-judgement/
	cd $(SRCDIR) && $(TSX) evaluation/compare.ts

setup: ## 【本実行の前に1回】前処理を一括（targets.all 生成→検出入力生成→クライアントの clone とコミット合わせ・ログは history/setup/<日時>-setup/logs）
	$(call run_logged,$(HIST)/setup/$(RUN_ID)-setup/logs,$(TSX) setup.ts)

prepare-clients: ## 検出入力 datasets/client_detect_clients.json のみ生成（setup の個別ステップ）
	$(call run_logged,$(HIST)/setup/$(RUN_ID)-prepare-clients/logs,$(TSX) setup/prepareClients.ts)

clone-clients: ## クライアントを clonedata/clientRepos にテストしたときのコミットでそろえる（無ければ clone・既存も checkout し直す・コミットが無ければ残して logs/clients_not_at_commit.csv に記録・要 prepare-clients・理由は logs/errors.jsonl）
	$(call run_logged,$(HIST)/setup/$(RUN_ID)-clone-clients/logs,$(TSX) setup/cloneClients.ts)

check-clients: ## [確認] clone-clients を何も変えずに数える（そろっている・checkout が要る・clone が要る）
	cd $(SRCDIR) && CLONE_DRY_RUN=1 $(TSX) setup/cloneClients.ts

clone-clients-sample: ## [検証] 5lib×5client を ../testclone に試し clone（本番の clientRepos は触らない）
	cd $(SRCDIR) && CLONE_SAMPLE=1 $(TSX) setup/cloneClients.ts

client-detect: ## [単体] 生成パターンをクライアントに照合 → latest/BC-LC-detect（＋history/BC-LC-detect/<日時>）。PATTERNS=パス/ディレクトリ・N=先頭lib数
	$(call run_logged,$(HIST)/BC-LC-detect/$(RUN_ID)/logs,$(HEAP) $(TSX) clientDetect/runClientDetect.ts $(PATTERNS) $(N))

scope: ## 外部API絞り込み mode0/1/2/3 の精度比較だけ単独で（run にも含まれる・高コスト）
	cd $(SRCDIR) && $(TSX) evaluation/scopeCompare.ts $(N)

tag-analysis: ## タグ別に fail/succ を集計 (FPのノイズ源特定)
	cd $(SRCDIR) && $(TSX) analysis/tagAnalysis.ts

pair-tags: ## 損失定義ポリシー掃引（records.json 由来）
	cd $(SRCDIR) && $(TSX) analysis/pairTags.ts

return-analysis: ## return-changed の内部兆候を分析
	cd $(SRCDIR) && $(TSX) analysis/returnAnalysis.ts

captured-symbols: ## 破壊検出＋パターン化した関数を列挙（.d.ts 未捕捉も突合）→ analysis/capturedSymbols/
	cd $(SRCDIR) && $(TSX) analysis/capturedSymbols.ts

dep-impact: ## [調査] 間接依存起因の見落とし: FN vs TN の依存 major-bump 率（→ BC-sample/depImpact/）
	cd $(SRCDIR) && $(TSX) depImpact/fnDepCorrelation.ts

show-result: ## 直近の混同行列 (compare_summary.json) を表示
	@cat ../outputs/latest/BC-LC/$(VARIANT)/results/loss-judgement/compare_summary.json

# ---------------------------------------------------------------
help: ## このヘルプを表示
	@echo ""
	@echo "BC-LC — 使用可能なコマンド一覧"
	@echo "────────────────────────────────────────────────────────"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""

.DEFAULT_GOAL := help
