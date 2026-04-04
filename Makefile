# NetTrace Makefile
# 用法：
#   make patch               # v0.4.0 → v0.4.1
#   make minor               # v0.4.0 → v0.5.0
#   make major               # v0.4.0 → v1.0.0
#   make release V=v0.5.0   # 指定版本号发布
#   make build               # 本地编译当前平台
#   make build-all           # 本地交叉编译 linux amd64/arm64
#   make clean               # 清理编译产物

BINARY  := nettrace
CURRENT := $(shell git tag --sort=-version:refname | grep -E '^v[0-9]' | head -1)

# 从当前 tag 解析 x y z
_VER   := $(patsubst v%,%,$(CURRENT))
_MAJOR := $(word 1,$(subst ., ,$(_VER)))
_MINOR := $(word 2,$(subst ., ,$(_VER)))
_PATCH := $(word 3,$(subst ., ,$(_VER)))

NEXT_PATCH := v$(_MAJOR).$(_MINOR).$(shell echo $$(( $(_PATCH) + 1 )))
NEXT_MINOR := v$(_MAJOR).$(shell echo $$(( $(_MINOR) + 1 ))).0
NEXT_MAJOR := v$(shell echo $$(( $(_MAJOR) + 1 ))).0.0

# ── 帮助 ────────────────────────────────────────────────────────
.DEFAULT_GOAL := help
.PHONY: help patch minor major release build build-all clean

help:
	@echo "当前版本: $(CURRENT)"
	@echo ""
	@echo "  make patch    → $(NEXT_PATCH)"
	@echo "  make minor    → $(NEXT_MINOR)"
	@echo "  make major    → $(NEXT_MAJOR)"
	@echo "  make release V=vX.Y.Z   指定版本号发布"
	@echo "  make build               本地编译（当前平台）"
	@echo "  make build-all           交叉编译 linux amd64 + arm64"
	@echo "  make clean               删除编译产物"

# ── 语义化版本升级 ────────────────────────────────────────────────
patch:
	@$(MAKE) release V=$(NEXT_PATCH)

minor:
	@$(MAKE) release V=$(NEXT_MINOR)

major:
	@$(MAKE) release V=$(NEXT_MAJOR)

# ── 发布（通用） ──────────────────────────────────────────────────
release:
ifndef V
	$(error 请指定版本号，例如: make release V=v0.5.0)
endif
	@echo "$(V)" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$$' \
		|| (echo "错误：版本号格式须为 vX.Y.Z"; exit 1)
	@git tag | grep -qx "$(V)" \
		&& (echo "错误：tag $(V) 已存在"; exit 1) || true
	@git diff --quiet && git diff --cached --quiet \
		|| (echo "错误：工作区有未提交的改动，请先 commit"; exit 1)
	@echo ">>> 编译验证..."
	@go build ./... || (echo "错误：编译失败，取消发布"; exit 1)
	@echo ">>> $(CURRENT) → $(V)"
	git tag $(V)
	git push origin $(V)
	@echo "✓ $(V) 已推送，等待 CI 构建完成"

# ── 本地构建 ─────────────────────────────────────────────────────
build:
	go build -trimpath -ldflags="-s -w" -o $(BINARY) .
	@echo "✓ 编译完成: ./$(BINARY)"

build-all:
	GOOS=linux GOARCH=amd64  CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BINARY)-linux-amd64 .
	GOOS=linux GOARCH=arm64  CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BINARY)-linux-arm64 .
	@echo "✓ 交叉编译完成:"
	@ls -lh $(BINARY)-linux-*

# ── 清理 ─────────────────────────────────────────────────────────
clean:
	rm -f $(BINARY) $(BINARY)-linux-amd64 $(BINARY)-linux-arm64
	@echo "✓ 清理完成"
