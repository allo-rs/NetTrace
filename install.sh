#!/usr/bin/env bash
# NetTrace 安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/allo-rs/NetTrace/main/install.sh | bash
# 或传入参数: DNS_DOMAIN=dns.example.com NS_IP=1.2.3.4 bash install.sh

set -euo pipefail

REPO="allo-rs/NetTrace"
INSTALL_DIR="/opt/nettrace"
SERVICE_NAME="nettrace"
BINARY_NAME="nettrace"
USER_NAME="nettrace"

# ── 颜色输出 ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── 前置检查 ──────────────────────────────────────────────
[[ "$(uname -s)" == "Linux" ]] || error "仅支持 Linux 系统"
command -v systemctl &>/dev/null || error "需要 systemd"
[[ $EUID -eq 0 ]] || error "请以 root 身份运行（sudo bash install.sh）"

# ── 检测架构 ──────────────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  GOARCH="amd64" ;;
  aarch64) GOARCH="arm64" ;;
  *)       error "不支持的架构: $ARCH（仅支持 x86_64 / aarch64）" ;;
esac

# ── 获取最新版本 ───────────────────────────────────────────
info "获取最新版本..."
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
[[ -n "$LATEST" ]] || error "无法获取最新版本，请检查网络或 GitHub Release 是否存在"
info "最新版本: $LATEST"

ARCHIVE="nettrace-${LATEST}-linux-${GOARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${ARCHIVE}"

# ── 下载并校验 ────────────────────────────────────────────
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "下载 $DOWNLOAD_URL ..."
curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/$ARCHIVE"

if curl -fsSL "${DOWNLOAD_URL}.sha256" -o "$TMP_DIR/${ARCHIVE}.sha256" 2>/dev/null; then
  info "校验 SHA256..."
  (cd "$TMP_DIR" && sha256sum -c "${ARCHIVE}.sha256") || error "SHA256 校验失败"
else
  warn "未找到 SHA256 文件，跳过校验"
fi

tar -xzf "$TMP_DIR/$ARCHIVE" -C "$TMP_DIR"

# ── 配置参数 ──────────────────────────────────────────────
if [[ -z "${DNS_DOMAIN:-}" ]]; then
  read -rp "请输入权威 DNS 域名（如 dns.example.com）: " DNS_DOMAIN < /dev/tty
fi
if [[ -z "${NS_IP:-}" ]]; then
  read -rp "请输入服务器公网 IP: " NS_IP < /dev/tty
fi
if [[ -z "${MAXMIND_LICENSE_KEY:-}" ]]; then
  echo "MaxMind License Key 用于自动下载/每日更新 GeoLite2-City 数据库。"
  echo "免费注册：https://www.maxmind.com/en/geolite2/signup"
  read -rp "请输入 MaxMind License Key（留空则跳过，需手动放置数据库文件）: " MAXMIND_LICENSE_KEY < /dev/tty
fi
WEB_PORT="${WEB_PORT:-:8080}"
DNS_PORT="${DNS_PORT:-:53}"
LOG_LEVEL="${LOG_LEVEL:-info}"

[[ -n "$DNS_DOMAIN" ]] || error "DNS_DOMAIN 不能为空"
[[ -n "$NS_IP" ]]     || error "NS_IP 不能为空"

# ── 安装文件 ──────────────────────────────────────────────
info "安装到 $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
cp "$TMP_DIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
cp "$TMP_DIR/index.html"   "$INSTALL_DIR/index.html"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# ── 创建专用系统用户 ──────────────────────────────────────
if ! id "$USER_NAME" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi
chown -R "$USER_NAME:$USER_NAME" "$INSTALL_DIR"

# 允许绑定 53 端口（不需要 root 运行）
setcap 'cap_net_bind_service=+ep' "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || \
  warn "setcap 失败，服务将以 root 权限绑定 53 端口"

# ── 写入 systemd 服务 ─────────────────────────────────────
GEO_KEY_LINE=""
[[ -n "$MAXMIND_LICENSE_KEY" ]] && GEO_KEY_LINE="Environment=MAXMIND_LICENSE_KEY=${MAXMIND_LICENSE_KEY}"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=NetTrace DNS Detector
After=network.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/${BINARY_NAME}
Restart=on-failure
RestartSec=5

Environment=DNS_DOMAIN=${DNS_DOMAIN}
Environment=NS_IP=${NS_IP}
Environment=WEB_PORT=${WEB_PORT}
Environment=DNS_PORT=${DNS_PORT}
Environment=LOG_LEVEL=${LOG_LEVEL}
Environment=GEODB_PATH=${INSTALL_DIR}/GeoLite2-City.mmdb
Environment=ASNDB_PATH=${INSTALL_DIR}/GeoLite2-ASN.mmdb
${GEO_KEY_LINE}

[Install]
WantedBy=multi-user.target
EOF

# ── 启动服务 ──────────────────────────────────────────────
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

info "✓ 安装完成！"
info "  服务状态: systemctl status $SERVICE_NAME"
info "  实时日志: journalctl -u $SERVICE_NAME -f"
info "  Web 界面: http://${NS_IP}${WEB_PORT}"
