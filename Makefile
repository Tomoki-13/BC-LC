# ==============================================================
# BC-LC Makefile
# ==============================================================
# P2: ライブラリ情報起点のパターン生成（実装途上）
# 現状は collectDataset（データセット収集）を提供する。
# ==============================================================

SHELL  := /bin/bash
SRCDIR := src
TSX    := npx tsx

# collectDataset の引数（コマンドラインで上書き可能）
#   make collect LIB=next VER=2.0.0 COUNT=5
LIB   ?= next
VER   ?= 2.0.0
COUNT ?= 5

.PHONY: install collect sample run-sample run-uuid run-globby \
        run detect compare scope tag-analysis pair-tags return-analysis dep-impact show-result help

# 分析系のパイロット件数（先頭 N lib だけ。空なら全件）
#   make scope N=5
N ?=

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

# ---------------------------------------------------------------
# 評価（詳細は README.md「評価パイプライン」）
#   run     : フルパイプライン。検出(重い1パス)→採点→分析3種を一括
#   detect  : 検出のみ（records.json だけ作り直す）
#   compare : 採点のみ（既存 records.json を読み直して再採点。高速）
# ---------------------------------------------------------------
run: ## フルパイプライン（正解生成→検出→採点→分析→scope。index.ts だけで全結果）
	cd $(SRCDIR) && $(TSX) index.ts

detect: ## 検出のみ実行 → detection/records.json
	cd $(SRCDIR) && $(TSX) evaluation/runDetection.ts $(N)

compare: ## 採点のみ（records.json を読み直す。検出はしない）→ eval/
	cd $(SRCDIR) && $(TSX) evaluation/compare.ts

scope: ## 外部API絞り込み mode0/1/2/3 の精度比較だけ単独で（run にも含まれる・高コスト）
	cd $(SRCDIR) && $(TSX) evaluation/scopeCompare.ts $(N)

tag-analysis: ## タグ別に fail/succ を集計 (FPのノイズ源特定)
	cd $(SRCDIR) && $(TSX) analysis/tagAnalysis.ts

pair-tags: ## 損失定義ポリシー掃引（records.json 由来）
	cd $(SRCDIR) && $(TSX) analysis/pairTags.ts

return-analysis: ## return-changed の内部兆候を分析
	cd $(SRCDIR) && $(TSX) analysis/returnAnalysis.ts

dep-impact: ## [調査] 間接依存起因の見落とし: FN vs TN の依存 major-bump 率（→ BC-sample/depImpact/）
	cd $(SRCDIR) && $(TSX) depImpact/fnDepCorrelation.ts

show-result: ## 直近の混同行列 (compare_summary.json) を表示
	@cat ../outputs/latest/BC-LC/eval/compare_summary.json

# ---------------------------------------------------------------
help: ## このヘルプを表示
	@echo ""
	@echo "BC-LC — 使用可能なコマンド一覧"
	@echo "────────────────────────────────────────────────────────"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""

.DEFAULT_GOAL := help
