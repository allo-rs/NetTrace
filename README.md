# NetTrace

网络诊断工具，集成 DNS 探测、路由追踪、网速测试、IPv6 检测、NAT 分析、IP 归属对比等功能。单二进制部署，前端通过 `go:embed` 内嵌。

---

## 核心功能

- **DNS 解析器探测**：权威 DNS 服务器（UDP/TCP 53），通过随机 token 子域名捕获用户的递归 DNS 解析器 IP 及归属地
- **DNS 泄漏检测**：多探针并行检测 DNS 解析器是否一致，识别 DNS 泄漏风险
- **路由追踪**：纯 Go ICMP traceroute，SSE 实时推送每一跳结果（IP、延迟、GeoIP 归属地），支持追踪到客户端或任意 IP/域名
- **网速测试**：基于 Cloudflare CDN 边缘节点，测量下载/上传速度、延迟和抖动
- **IPv6 双栈检测**：检测 IPv4/IPv6 连接状态、各协议 IP 地址及归属地、浏览器协议偏好
- **NAT 类型检测**：WebRTC ICE 候选地址分析（开放/完全锥形/受限锥形/对称型），显示公网映射和端口一致性
- **DNS 基准测试**：对比 9 大公共 DNS 解析器的响应速度，SSE 实时推送并排序
- **IP 类型识别**：ASN 数据库 + 关键词匹配 + PTR 反查，判断 IP 类型（住宅/机房/VPN/移动），质量评分 0-100
- **多源 IP 对比**：并行查询 MaxMind、ipinfo.io、ip-api.com、Cloudflare 四个数据源，交叉验证一致性
- **HTTP/浏览器指纹**：Canvas 哈希、WebGL 渲染器、时区、HTTP 请求头等
- **流媒体解锁检测**：前端直连检测 Netflix、YouTube、ChatGPT 等 8 大服务的可访问性

---

## 技术架构

```
NetTrace/
├── main.go                          # Go 后端（DNS + HTTP + API）
├── index.html                       # 旧版前端（保留备用）
├── frontend/                        # SolidJS 前端（通过 go:embed 内嵌进二进制）
│   ├── build.ts                     # Bun 构建脚本（自定义 SolidJS 插件）
│   ├── public/index.html            # HTML 入口（含 {{.Domain}} 占位符）
│   └── src/
│       ├── App.tsx                   # 主应用（3 Tab 导航）
│       ├── components/              # 10 个功能组件
│       │   ├── LeakSection.tsx      # DNS 泄漏检测
│       │   ├── IPv6Section.tsx      # IPv6 双栈
│       │   ├── SpeedSection.tsx     # 网速测试
│       │   ├── TraceSection.tsx     # 路由追踪（SSE）
│       │   ├── DNSBenchSection.tsx  # DNS 基准（SSE）
│       │   ├── NATSection.tsx       # NAT 类型
│       │   ├── IPTypeSection.tsx    # IP 类型多源对比
│       │   ├── UnlockSection.tsx    # 流媒体解锁
│       │   ├── FPSection.tsx        # 浏览器指纹
│       │   └── TabNav.tsx           # Tab 导航
│       ├── lib/api.ts               # 共享工具函数
│       └── styles/global.css        # 全局样式
├── install.sh                       # 一键安装脚本
├── Makefile                         # 构建 & 发布
├── .github/workflows/release.yml    # CI/CD
└── go.mod
```

**前端技术栈**：SolidJS + TypeScript，Bun 构建（自定义插件 + babel-preset-solid，无 Vite）  
**部署方式**：`go:embed` 将前端编译进 Go 二进制，真正的单文件部署

---

## 构建

```bash
# 完整构建（前端 + Go）
make build

# 仅构建前端
make frontend

# 交叉编译
make build-all
```

需要：[Go 1.21+](https://go.dev/dl/) + [Bun](https://bun.sh/)

---

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DNS_DOMAIN` | `dns.example.com` | 权威 DNS 区域（必填） |
| `NS_IP` | `1.2.3.4` | 服务器公网 IP（必填） |
| `WEB_PORT` | `:8080` | HTTP 监听端口 |
| `DNS_PORT` | `:53` | DNS 监听端口 |
| `LOG_LEVEL` | `info` | 日志等级（debug/info/warn/error） |
| `MAXMIND_LICENSE_KEY` | — | MaxMind GeoLite2 许可证（自动下载数据库） |
| `DNS_ALLOW_ZONES` | — | 追加白名单区域，逗号分隔 |

---

## 部署

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/allo-rs/NetTrace/main/install.sh | sudo bash
```

脚本会交互式询问配置，也可以预设：

```bash
DNS_DOMAIN=dns.example.com NS_IP=1.2.3.4 \
  curl -fsSL https://raw.githubusercontent.com/allo-rs/NetTrace/main/install.sh | sudo bash
```

### 域名配置（必须）

在域名 DNS 面板添加：

| 类型 | 名称 | 值 | 说明 |
|------|------|-----|------|
| A    | ns1.dns | `服务器IP` | NS 地址解析 |
| A    | ns2.dns | `服务器IP` | NS 地址解析 |
| NS   | dns    | ns1.dns.example.com | 权威委派 |
| NS   | dns    | ns2.dns.example.com | 权威委派 |

> NS 记录让 `dns.example.com` 的权威 DNS 指向你的服务器。

### Caddy 反代（可选）

```
dns.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 自动申请 HTTPS 证书，无需额外配置。

---

## 验证

```bash
# DNS 是否正常
dig @服务器IP test123.dns.example.com A

# Web 是否正常
curl http://dns.example.com:8080/
```

---

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/info` | GET | DNS 探测结果（client IP + resolver IP + geo） |
| `/api/leak` | GET/DELETE | DNS 泄漏检测 |
| `/api/geo` | GET | IP 地理信息查询 |
| `/api/trace` | GET | 路由追踪（SSE 流式） |
| `/api/dns-bench` | GET | DNS 基准测试（SSE 流式） |
| `/api/ip-type` | GET | IP 类型识别 + 质量评分 |
| `/api/ip-check` | GET | ip-api.com 代理查询 |
| `/api/headers` | GET | HTTP 请求头回显 |
| `/api/unlock` | GET | 流媒体解锁检测 |
| `/api/stats` | GET | 服务统计 |

---

## 常见问题

**Q: 53 端口被占用？**
```bash
sudo systemctl disable --now systemd-resolved
sudo rm /etc/resolv.conf
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
```

**Q: DNS 解析器未能捕获？**
- Chrome 等浏览器默认启用 DoH（DNS over HTTPS），DNS 查询不走传统 DNS
- 可让用户关闭「使用安全 DNS」设置

**Q: 路由追踪显示超时？**
- 部分云服务器/运营商屏蔽 ICMP，属于正常现象
- 需要 `cap_net_raw` 能力（安装脚本自动设置）

