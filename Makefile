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

.PHONY: install collect sample run-sample run-uuid run-globby help

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
help: ## このヘルプを表示
	@echo ""
	@echo "BC-LC — 使用可能なコマンド一覧"
	@echo "────────────────────────────────────────────────────────"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""

.DEFAULT_GOAL := help
