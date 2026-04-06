#!/usr/bin/env bash
# NetTrace 安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/allo-rs/NetTrace/main/install.sh | bash
# 或传入参数: DNS_DOMAIN=dns.example.com NS_IP=1.2.3.4 bash install.sh
# 强制重新配置: bash install.sh --reconfigure

set -euo pipefail

REPO="allo-rs/NetTrace"
INSTALL_DIR="/opt/nettrace"
SERVICE_NAME="nettrace"
BINARY_NAME="nettrace"
USER_NAME="nettrace"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
FORCE_RECONFIG=false

# 解析参数
for arg in "$@"; do
  case "$arg" in
    --reconfigure|--force|-f) FORCE_RECONFIG=true ;;
  esac
done

# ── 颜色输出 ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── 从已有 service 文件读取旧配置 ──────────────────────────
load_existing_config() {
  if [[ -f "$SERVICE_FILE" ]]; then
    info "检测到已有配置，读取旧值..."
    local line
    while IFS= read -r line; do
      if [[ "$line" =~ ^Environment=([A-Z_]+)=(.*)$ ]]; then
        local key="${BASH_REMATCH[1]}"
        local val="${BASH_REMATCH[2]}"
        case "$key" in
          DNS_DOMAIN)         OLD_DNS_DOMAIN="$val" ;;
          NS_IP)              OLD_NS_IP="$val" ;;
          MAXMIND_LICENSE_KEY) OLD_MAXMIND_LICENSE_KEY="$val" ;;
          WEB_PORT)           OLD_WEB_PORT="$val" ;;
          DNS_PORT)           OLD_DNS_PORT="$val" ;;
          LOG_LEVEL)          OLD_LOG_LEVEL="$val" ;;
        esac
      fi
    done < "$SERVICE_FILE"
  fi
}

# 如果环境变量没设、旧值存在且非强制模式，使用旧值；否则交互式提示
prompt_or_reuse() {
  local var_name="$1" prompt_text="$2" old_val="${3:-}" required="${4:-true}"
  local current_val="${!var_name:-}"

  # 已通过环境变量设置，直接使用
  if [[ -n "$current_val" ]]; then
    return
  fi

  # 有旧值 且 非强制模式，复用旧值
  if [[ -n "$old_val" ]] && ! $FORCE_RECONFIG; then
    info "  $var_name = $old_val （沿用已有配置）"
    eval "$var_name=\"$old_val\""
    return
  fi

  # 交互式输入
  local default_hint=""
  [[ -n "$old_val" ]] && default_hint="（回车保留: $old_val）"
  local input
  read -rp "  $prompt_text $default_hint: " input < /dev/tty
  if [[ -z "$input" && -n "$old_val" ]]; then
    eval "$var_name=\"$old_val\""
  else
    eval "$var_name=\"$input\""
  fi
}

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
OLD_DNS_DOMAIN="" OLD_NS_IP="" OLD_MAXMIND_LICENSE_KEY=""
OLD_WEB_PORT="" OLD_DNS_PORT="" OLD_LOG_LEVEL=""
load_existing_config

echo ""
if $FORCE_RECONFIG; then
  info "强制重新配置模式（--reconfigure）"
elif [[ -f "$SERVICE_FILE" ]]; then
  info "升级模式：已有配置将自动沿用，无需重复输入"
fi

prompt_or_reuse DNS_DOMAIN "请输入权威 DNS 域名（如 dns.example.com）" "$OLD_DNS_DOMAIN"
prompt_or_reuse NS_IP "请输入服务器公网 IP" "$OLD_NS_IP"

if [[ -z "${MAXMIND_LICENSE_KEY:-}" ]]; then
  if [[ -n "$OLD_MAXMIND_LICENSE_KEY" ]] && ! $FORCE_RECONFIG; then
    info "  MAXMIND_LICENSE_KEY = ***（沿用已有配置）"
    MAXMIND_LICENSE_KEY="$OLD_MAXMIND_LICENSE_KEY"
  else
    echo "  MaxMind License Key 用于自动下载/每日更新 GeoLite2-City 数据库。"
    echo "  免费注册：https://www.maxmind.com/en/geolite2/signup"
    local_hint=""
    [[ -n "$OLD_MAXMIND_LICENSE_KEY" ]] && local_hint="（回车保留旧值）"
    read -rp "  请输入 MaxMind License Key（留空跳过）$local_hint: " MAXMIND_LICENSE_KEY < /dev/tty
    [[ -z "$MAXMIND_LICENSE_KEY" && -n "$OLD_MAXMIND_LICENSE_KEY" ]] && MAXMIND_LICENSE_KEY="$OLD_MAXMIND_LICENSE_KEY"
  fi
fi

WEB_PORT="${WEB_PORT:-${OLD_WEB_PORT:-:8080}}"
DNS_PORT="${DNS_PORT:-${OLD_DNS_PORT:-:53}}"
LOG_LEVEL="${LOG_LEVEL:-${OLD_LOG_LEVEL:-info}}"

[[ -n "$DNS_DOMAIN" ]] || error "DNS_DOMAIN 不能为空"
[[ -n "$NS_IP" ]]     || error "NS_IP 不能为空"

# ── 停止已有服务（避免 Text file busy）──────────────────────
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "停止已有服务..."
  systemctl stop "$SERVICE_NAME"
fi

# ── 安装文件 ──────────────────────────────────────────────
info "安装到 $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
cp "$TMP_DIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# ── 创建专用系统用户 ──────────────────────────────────────
if ! id "$USER_NAME" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi
chown -R "$USER_NAME:$USER_NAME" "$INSTALL_DIR"

# 允许绑定 53 端口 + ICMP（traceroute）
setcap 'cap_net_bind_service,cap_net_raw=+ep' "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || \
  warn "setcap 失败，服务将以 root 权限运行"

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
echo ""
info "  版本:     $LATEST"
info "  域名:     $DNS_DOMAIN"
info "  公网 IP:  $NS_IP"
info "  Web 端口: $WEB_PORT"
info "  DNS 端口: $DNS_PORT"
info "  MaxMind:  ${MAXMIND_LICENSE_KEY:+已配置}${MAXMIND_LICENSE_KEY:-未配置}"
echo ""
info "  服务状态: systemctl status $SERVICE_NAME"
info "  实时日志: journalctl -u $SERVICE_NAME -f"
info "  Web 界面: http://${NS_IP}${WEB_PORT}"
info "  重新配置: bash install.sh --reconfigure"
