// nettrace — 权威 DNS 服务器 + Web 后端
//
// 工作原理：
//   1. 前端生成随机 token，触发对 <token>.dns.yourdomain.com 的 DNS 查询
//   2. 用户的 DNS 解析器（递归解析器）将请求转发至本服务器（权威 DNS）
//   3. 本服务器在 UDP/TCP 53 端口接收查询，记录 token → 解析器IP 的映射
//   4. 前端轮询 /api/info?token=xxx，后端返回客户端IP + DNS解析器IP + 归属地信息

package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/maxminddb-golang"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

// ══════════════════════════════════════════════════════════
//  日志系统
// ══════════════════════════════════════════════════════════

// LogLevel 定义日志等级，数值越大越详细。
// 生产环境建议设为 LevelInfo，调试时设为 LevelDebug。
type LogLevel int

const (
	LevelDebug LogLevel = iota // 0 — 详细调试信息（每条 DNS 查询、缓存命中等）
	LevelInfo                  // 1 — 关键流程信息（启动、token 捕获、清理统计）
	LevelWarn                  // 2 — 非致命异常（速率限制触发、geo 查询失败）
	LevelError                 // 3 — 致命错误（监听失败等）
)

// levelName 用于日志前缀显示。
var levelName = map[LogLevel]string{
	LevelDebug: "DEBUG",
	LevelInfo:  "INFO ",
	LevelWarn:  "WARN ",
	LevelError: "ERROR",
}

// Logger 是全局带等级的日志器。
// 只有 level >= minLevel 的日志才会输出。
type Logger struct {
	minLevel LogLevel
	inner    *log.Logger // 底层使用标准库 log，保留时间戳前缀
}

// newLogger 创建 Logger。
//
//	minLevel — 最低输出等级
//	out      — 输出目标（通常为 os.Stdout 或文件）
func newLogger(minLevel LogLevel, out io.Writer) *Logger {
	return &Logger{
		minLevel: minLevel,
		inner:    log.New(out, "", log.LstdFlags|log.Lmicroseconds),
	}
}

func (l *Logger) log(level LogLevel, format string, args ...any) {
	if level < l.minLevel {
		return // 低于最小等级，直接丢弃，零 I/O 开销
	}
	prefix := "[" + levelName[level] + "] "
	l.inner.Printf(prefix+format, args...)
}

// Debug 记录调试信息（例如每条 DNS 查询细节）。
// 生产环境 minLevel=Info 时此方法零开销（条件在入口即返回）。
func (l *Logger) Debug(format string, args ...any) { l.log(LevelDebug, format, args...) }

// Info 记录关键流程节点。
func (l *Logger) Info(format string, args ...any) { l.log(LevelInfo, format, args...) }

// Warn 记录非致命异常，需要关注但不影响主流程。
func (l *Logger) Warn(format string, args ...any) { l.log(LevelWarn, format, args...) }

// Error 记录需要立即处理的错误。
func (l *Logger) Error(format string, args ...any) { l.log(LevelError, format, args...) }

// parseLogLevel 将环境变量字符串转为 LogLevel。
// 未识别的字符串默认返回 LevelInfo。
func parseLogLevel(s string) LogLevel {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "info":
		return LevelInfo
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

// 全局 logger，在 main() 中初始化后供各模块使用。
var logger *Logger

// ══════════════════════════════════════════════════════════
//  配置
// ══════════════════════════════════════════════════════════

// Config 保存服务器运行所需的全部配置，通过环境变量注入。
type Config struct {
	Domain    string   // 权威 DNS 区域，例如 "dns.example.com"
	NSIP      string   // 本服务器的公网 IP
	WebPort   string   // HTTP 监听端口，例如 ":8080"
	DNSPort   string   // DNS 监听端口，通常为 ":53"
	LogLevel  LogLevel // 日志输出等级
	GeoDBPath     string // MaxMind GeoLite2-City 数据库文件路径
	ASNDBPath     string // MaxMind GeoLite2-ASN 数据库文件路径
	GeoLicenseKey string // MaxMind 许可证 Key，用于自动下载/更新数据库

	// AllowedZones 是 DNS 查询的域名白名单。
	// 只有 qname 属于这些区域的查询才会被处理，其他返回 REFUSED。
	// 始终包含 Config.Domain 本身，可通过 DNS_ALLOW_ZONES 追加额外区域。
	AllowedZones []string
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// buildConfig 从环境变量构建 Config，同时做规范化处理。
func buildConfig() *Config {
	domain := strings.ToLower(strings.TrimSuffix(
		getEnv("DNS_DOMAIN", "dns.example.com"), "."))

	cfg := &Config{
		Domain:    domain,
		NSIP:      getEnv("NS_IP", "1.2.3.4"),
		WebPort:   getEnv("WEB_PORT", ":8080"),
		DNSPort:   getEnv("DNS_PORT", ":53"),
		LogLevel:      parseLogLevel(getEnv("LOG_LEVEL", "info")),
		GeoDBPath:     getEnv("GEODB_PATH", "GeoLite2-City.mmdb"),
		ASNDBPath:     getEnv("ASNDB_PATH", "GeoLite2-ASN.mmdb"),
		GeoLicenseKey: getEnv("MAXMIND_LICENSE_KEY", ""),
	}

	// 白名单始终包含主域名本身
	zoneSet := map[string]struct{}{domain: {}}

	// DNS_ALLOW_ZONES 允许追加额外区域，逗号分隔
	// 例如：DNS_ALLOW_ZONES=dns.example.com,probe.another.com
	if extra := getEnv("DNS_ALLOW_ZONES", ""); extra != "" {
		for _, z := range strings.Split(extra, ",") {
			z = strings.ToLower(strings.TrimSpace(strings.TrimSuffix(z, ".")))
			if z != "" {
				zoneSet[z] = struct{}{}
			}
		}
	}

	for z := range zoneSet {
		cfg.AllowedZones = append(cfg.AllowedZones, z)
	}
	return cfg
}

// isAllowedZone 判断 qname 是否属于白名单中某个区域。
// 规则：qname == zone 本身，或者 qname 以 "."+zone 结尾（子域名）。
func (c *Config) isAllowedZone(qname string) bool {
	for _, zone := range c.AllowedZones {
		if qname == zone || strings.HasSuffix(qname, "."+zone) {
			return true
		}
	}
	return false
}

// ══════════════════════════════════════════════════════════
//  Token Store
// ══════════════════════════════════════════════════════════

type tokenEntry struct {
	resolverIP string
	createdAt  time.Time
}

// TokenStore 存储 token → DNS解析器IP 的映射。
//
// 设计要点：
//  1. sync.RWMutex 保证并发安全
//  2. token 被 HTTP 端读取后立即删除（一次性消费）
//  3. 后台定时清理兜底：未被消费的过期 token 也会被清除
//  4. 写入速率限制：防止攻击者用随机 DNS 查询打爆内存
type TokenStore struct {
	mu      sync.RWMutex
	entries map[string]tokenEntry

	rateMu    sync.Mutex
	rateCount map[string]int // resolverIP → 当前窗口内写入次数
	rateReset time.Time      // 当前速率窗口的结束时间
}

const (
	rateWindowDur = time.Minute
	rateMaxPerIP  = 60 // 每个解析器 IP 每分钟最多写入 60 个 token
	tokenTTL      = 5 * time.Minute
)

func NewTokenStore() *TokenStore {
	s := &TokenStore{
		entries:   make(map[string]tokenEntry),
		rateCount: make(map[string]int),
		rateReset: time.Now().Add(rateWindowDur),
	}
	go func() {
		for range time.NewTicker(time.Minute).C {
			s.mu.Lock()
			cutoff := time.Now().Add(-tokenTTL)
			cleaned := 0
			for k, v := range s.entries {
				if v.createdAt.Before(cutoff) {
					delete(s.entries, k)
					cleaned++
				}
			}
			size := len(s.entries)
			s.mu.Unlock()
			if cleaned > 0 {
				logger.Info("TokenStore 清理过期 token: cleaned=%d remaining=%d", cleaned, size)
			} else {
				logger.Debug("TokenStore 定时扫描: no expired tokens, size=%d", size)
			}
		}
	}()
	return s
}

// Set 写入 token → resolverIP。若触发速率限制返回 false。
func (s *TokenStore) Set(token, resolverIP string) bool {
	s.rateMu.Lock()
	now := time.Now()
	if now.After(s.rateReset) {
		s.rateCount = make(map[string]int)
		s.rateReset = now.Add(rateWindowDur)
	}
	s.rateCount[resolverIP]++
	count := s.rateCount[resolverIP]
	s.rateMu.Unlock()

	if count > rateMaxPerIP {
		logger.Warn("速率限制: resolverIP=%s 本分钟写入 %d 次，丢弃 token=%s", resolverIP, count, token)
		return false
	}

	s.mu.Lock()
	s.entries[token] = tokenEntry{resolverIP: resolverIP, createdAt: now}
	s.mu.Unlock()
	return true
}

// Get 查询并一次性消费 token（读取即删除，double-check 防竞态）。
func (s *TokenStore) Get(token string) (string, bool) {
	// 第一次检查（读锁，性能优先）
	s.mu.RLock()
	_, ok := s.entries[token]
	s.mu.RUnlock()
	if !ok {
		return "", false
	}

	// 升级为写锁，二次确认并删除（防止两个并发请求都消费同一 token）
	s.mu.Lock()
	e, ok := s.entries[token]
	if ok {
		delete(s.entries, token)
	}
	s.mu.Unlock()

	if !ok {
		return "", false
	}
	return e.resolverIP, true
}

func (s *TokenStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries)
}

// Peek 查询 token 对应的 resolverIP，但不删除（非消费性读取）。
// 用于 DNS 泄漏检测的多轮轮询。
func (s *TokenStore) Peek(token string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.entries[token]
	if !ok {
		return "", false
	}
	return e.resolverIP, true
}

// Delete 显式删除一组 token（泄漏检测结束后清理）。
func (s *TokenStore) Delete(tokens []string) {
	s.mu.Lock()
	for _, t := range tokens {
		delete(s.entries, t)
	}
	s.mu.Unlock()
}

// ══════════════════════════════════════════════════════════
//  MaxMind GeoLite2 数据库
// ══════════════════════════════════════════════════════════

type geoDBReader struct {
	db *maxminddb.Reader
}

type maxmindRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
		Names   struct {
			ZhCN string `maxminddb:"zh-CN"`
		} `maxminddb:"names"`
	} `maxminddb:"country"`
	Subdivisions []struct {
		Names struct {
			ZhCN string `maxminddb:"zh-CN"`
		} `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	City struct {
		Names struct {
			ZhCN string `maxminddb:"zh-CN"`
		} `maxminddb:"names"`
	} `maxminddb:"city"`
	Location struct {
		Latitude  float64 `maxminddb:"latitude"`
		Longitude float64 `maxminddb:"longitude"`
	} `maxminddb:"location"`
}

var (
	geoDBMu sync.RWMutex
	geoDB   *geoDBReader
)

// downloadGeoDB 从 MaxMind 下载指定 edition 的数据库并覆盖到 destPath。
// editionID 例如 "GeoLite2-City" 或 "GeoLite2-ASN"。
func downloadGeoDB(editionID, destPath, licenseKey string) error {
	if licenseKey == "" {
		return fmt.Errorf("MAXMIND_LICENSE_KEY 未设置，无法下载数据库")
	}
	url := fmt.Sprintf(
		"https://download.maxmind.com/app/geoip_download?edition_id=%s&license_key=%s&suffix=tar.gz",
		editionID, licenseKey,
	)
	logger.Info("下载 %s.mmdb ...", editionID)
	resp, err := http.Get(url) //nolint:gosec
	if err != nil {
		return fmt.Errorf("下载失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载失败，HTTP %d（许可证 Key 是否正确？）", resp.StatusCode)
	}

	// 解压 tar.gz，提取 *.mmdb 文件
	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return fmt.Errorf("解压 gzip 失败: %v", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("读取 tar 失败: %v", err)
		}
		if !strings.HasSuffix(hdr.Name, ".mmdb") {
			continue
		}
		// 写入临时文件，成功后原子替换
		tmp := destPath + ".tmp"
		f, err := os.Create(tmp)
		if err != nil {
			return fmt.Errorf("创建临时文件失败: %v", err)
		}
		if _, err = io.Copy(f, tr); err != nil {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("写入文件失败: %v", err)
		}
		f.Close()
		if err = os.Rename(tmp, destPath); err != nil {
			os.Remove(tmp)
			return fmt.Errorf("替换文件失败: %v", err)
		}
		logger.Info("%s.mmdb 已更新: %s", editionID, destPath)
		return nil
	}
	return fmt.Errorf("tar 包中未找到 .mmdb 文件")
}

// loadGeoDB 打开数据库文件并热替换全局 geoDB（持写锁）。
func loadGeoDB(path string) error {
	db, err := maxminddb.Open(path)
	if err != nil {
		return fmt.Errorf("打开 MaxMind 数据库失败: %v", err)
	}
	geoDBMu.Lock()
	old := geoDB
	geoDB = &geoDBReader{db: db}
	geoDBMu.Unlock()
	if old != nil && old.db != nil {
		old.db.Close()
	}
	logger.Info("MaxMind GeoLite2 数据库已加载: %s", path)
	return nil
}

// initCityDB 启动时初始化 City 数据库：若文件不存在则先下载，再加载。
func initCityDB(path, licenseKey string) error {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		logger.Info("City 数据库文件不存在，开始首次下载...")
		if err := downloadGeoDB("GeoLite2-City", path, licenseKey); err != nil {
			return err
		}
	}
	return loadGeoDB(path)
}

// ── ASN 数据库 ────────────────────────────────────────────

var (
	asnDBMu sync.RWMutex
	asnDB   *geoDBReader
)

type asnRecord struct {
	AutonomousSystemNumber       uint   `maxminddb:"autonomous_system_number"`
	AutonomousSystemOrganization string `maxminddb:"autonomous_system_organization"`
}

// loadASNDB 打开 ASN 数据库并热替换全局 asnDB。
func loadASNDB(path string) error {
	db, err := maxminddb.Open(path)
	if err != nil {
		return fmt.Errorf("打开 ASN 数据库失败: %v", err)
	}
	asnDBMu.Lock()
	old := asnDB
	asnDB = &geoDBReader{db: db}
	asnDBMu.Unlock()
	if old != nil && old.db != nil {
		old.db.Close()
	}
	logger.Info("GeoLite2-ASN 数据库已加载: %s", path)
	return nil
}

// initASNDB 启动时初始化 ASN 数据库：若文件不存在则先下载，再加载。
func initASNDB(path, licenseKey string) error {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		logger.Info("ASN 数据库文件不存在，开始首次下载...")
		if err := downloadGeoDB("GeoLite2-ASN", path, licenseKey); err != nil {
			return err
		}
	}
	return loadASNDB(path)
}

// startGeoUpdater 启动每日定时更新协程，同时更新 City 和 ASN 数据库。
func startGeoUpdater(cityPath, asnPath, licenseKey string) {
	if licenseKey == "" {
		logger.Warn("MAXMIND_LICENSE_KEY 未设置，跳过 GeoLite2 自动更新")
		return
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			logger.Info("GeoLite2 定时更新开始...")
			if err := downloadGeoDB("GeoLite2-City", cityPath, licenseKey); err != nil {
				logger.Warn("City 数据库更新下载失败: %v", err)
			} else if err := loadGeoDB(cityPath); err != nil {
				logger.Warn("City 数据库更新加载失败: %v", err)
			}
			if err := downloadGeoDB("GeoLite2-ASN", asnPath, licenseKey); err != nil {
				logger.Warn("ASN 数据库更新下载失败: %v", err)
			} else if err := loadASNDB(asnPath); err != nil {
				logger.Warn("ASN 数据库更新加载失败: %v", err)
			}
		}
	}()
}

func closeGeoDB() {
	geoDBMu.Lock()
	if geoDB != nil && geoDB.db != nil {
		geoDB.db.Close()
	}
	geoDBMu.Unlock()

	asnDBMu.Lock()
	if asnDB != nil && asnDB.db != nil {
		asnDB.db.Close()
	}
	asnDBMu.Unlock()
}

// ══════════════════════════════════════════════════════════
//  Geo 缓存
// ══════════════════════════════════════════════════════════

// specialRegionCodes 将特殊地区代码映射到正确的国家中文名
var specialRegionCodes = map[string]string{
	"HK": "中国香港",
	"TW": "中国台湾",
	"MO": "中国澳门",
}

type geoEntry struct {
	info     *GeoInfo
	cachedAt time.Time
}

const geoCacheTTL = 10 * time.Minute

type GeoCache struct {
	mu    sync.RWMutex
	cache map[string]geoEntry
}

func NewGeoCache() *GeoCache {
	g := &GeoCache{cache: make(map[string]geoEntry)}
	go func() {
		for range time.NewTicker(5 * time.Minute).C {
			g.mu.Lock()
			cutoff := time.Now().Add(-geoCacheTTL)
			cleaned := 0
			for k, v := range g.cache {
				if v.cachedAt.Before(cutoff) {
					delete(g.cache, k)
					cleaned++
				}
			}
			g.mu.Unlock()
			if cleaned > 0 {
				logger.Info("GeoCache 清理过期条目: cleaned=%d", cleaned)
			}
		}
	}()
	return g
}

func (g *GeoCache) Get(ip string) (*GeoInfo, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	e, ok := g.cache[ip]
	if !ok || time.Since(e.cachedAt) > geoCacheTTL {
		return nil, false
	}
	return e.info, true
}

func (g *GeoCache) Set(ip string, info *GeoInfo) {
	g.mu.Lock()
	g.cache[ip] = geoEntry{info: info, cachedAt: time.Now()}
	g.mu.Unlock()
}

// ══════════════════════════════════════════════════════════
//  DNS 协议实现（RFC 1035）
// ══════════════════════════════════════════════════════════

// parseQuery 解析 DNS 请求报文，提取事务ID、QNAME、QTYPE。
func parseQuery(buf []byte) (id uint16, qname string, qtype uint16, ok bool) {
	if len(buf) < 12 {
		return
	}
	id = binary.BigEndian.Uint16(buf[0:2])
	qdcount := binary.BigEndian.Uint16(buf[4:6])
	if qdcount == 0 {
		ok = true
		return
	}
	pos := 12
	var labels []string
	for pos < len(buf) {
		length := int(buf[pos])
		if length == 0 {
			pos++
			break
		}
		if length&0xC0 == 0xC0 {
			pos += 2
			break
		}
		pos++
		if pos+length > len(buf) {
			return
		}
		labels = append(labels, string(buf[pos:pos+length]))
		pos += length
	}
	if pos+4 > len(buf) {
		return
	}
	qname = strings.ToLower(strings.Join(labels, "."))
	qtype = binary.BigEndian.Uint16(buf[pos:])
	ok = true
	return
}

// encodeName 将点分域名编码为 DNS wire-format 标签序列。
func encodeName(name string) []byte {
	var b []byte
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if label == "" {
			continue
		}
		b = append(b, byte(len(label)))
		b = append(b, []byte(label)...)
	}
	b = append(b, 0x00)
	return b
}

// buildReply 构造标准 DNS 响应报文（FLAGS: QR=1 AA=1 RCODE=0）。
func buildReply(id uint16, qname string, qtype uint16, aRecords []net.IP, nsNames []string) []byte {
	var h [12]byte
	binary.BigEndian.PutUint16(h[0:], id)
	binary.BigEndian.PutUint16(h[2:], 0x8400) // QR=1 AA=1
	binary.BigEndian.PutUint16(h[4:], 1)
	binary.BigEndian.PutUint16(h[6:], uint16(len(aRecords)+len(nsNames)))

	qnw := encodeName(qname)
	var qt [4]byte
	binary.BigEndian.PutUint16(qt[0:], qtype)
	binary.BigEndian.PutUint16(qt[2:], 1)

	buf := make([]byte, 0, 512)
	buf = append(buf, h[:]...)
	buf = append(buf, qnw...)
	buf = append(buf, qt[:]...)

	for _, ip := range aRecords {
		buf = append(buf, encodeName(qname)...)
		buf = append(buf, 0x00, 0x01, 0x00, 0x01)
		buf = append(buf, 0x00, 0x00, 0x00, 0x01) // TTL=1s，防解析器缓存
		buf = append(buf, 0x00, 0x04)
		buf = append(buf, ip.To4()...)
	}
	for _, ns := range nsNames {
		nw := encodeName(ns)
		buf = append(buf, encodeName(qname)...)
		buf = append(buf, 0x00, 0x02, 0x00, 0x01)
		buf = append(buf, 0x00, 0x00, 0x0E, 0x10) // TTL=3600s
		buf = append(buf, 0x00, byte(len(nw)))
		buf = append(buf, nw...)
	}
	return buf
}

// buildRefused 构造 REFUSED 响应（RCODE=5）。
// 用于拒绝非白名单域名的查询，告知对方"我没有权限回答这个问题"。
// 相比直接丢弃，REFUSED 能让对方解析器快速得知结果，而不是等到超时。
func buildRefused(id uint16, qname string, qtype uint16) []byte {
	var h [12]byte
	binary.BigEndian.PutUint16(h[0:], id)
	// FLAGS: QR=1(响应) AA=0(非权威，因为我们不负责此域) RCODE=5(REFUSED)
	binary.BigEndian.PutUint16(h[2:], 0x8005)
	binary.BigEndian.PutUint16(h[4:], 1) // QDCOUNT=1，回填问题节

	// 回填 Question 节（标准要求响应中包含原始问题）
	qnw := encodeName(qname)
	var qt [4]byte
	binary.BigEndian.PutUint16(qt[0:], qtype)
	binary.BigEndian.PutUint16(qt[2:], 1)

	buf := make([]byte, 0, 32)
	buf = append(buf, h[:]...)
	buf = append(buf, qnw...)
	buf = append(buf, qt[:]...)
	return buf
}

// ══════════════════════════════════════════════════════════
//  DNS 服务器
// ══════════════════════════════════════════════════════════

type DNSServer struct {
	cfg   *Config
	store *TokenStore
}

// handle 是 DNS 请求的核心路由。
//
// 处理顺序：
//  1. 解析报文，提取 qname / qtype
//  2. 白名单检查：qname 不属于任何允许区域 → REFUSED（并记录 Warn 日志）
//  3. 路由到具体记录类型处理
func (d *DNSServer) handle(data []byte, remoteAddr net.Addr) []byte {
	id, qname, qtype, ok := parseQuery(data)
	if !ok {
		logger.Warn("DNS 报文解析失败，来自 %s，丢弃", remoteAddr)
		return nil
	}
	if qname == "" {
		// 无问题节的合法报文，忽略即可
		logger.Debug("DNS 无问题节报文，来自 %s，忽略", remoteAddr)
		return nil
	}

	// ── 白名单检查 ────────────────────────────────────────────
	// 只处理属于已配置区域的查询，其他一律 REFUSED。
	// 防止：
	//   a. 本服务器被用作"开放解析器"转发任意查询
	//   b. 探测扫描/DDoS 利用本端口
	if !d.cfg.isAllowedZone(qname) {
		logger.Warn("域名白名单拒绝: qname=%s qtype=%d from=%s (allowed=%v)",
			qname, qtype, remoteAddr, d.cfg.AllowedZones)
		return buildRefused(id, qname, qtype)
	}

	// 白名单通过后的处理逻辑记录为 Debug（生产环境高频，不需要 Info）
	logger.Debug("DNS 查询: qname=%s qtype=%d from=%s", qname, qtype, remoteAddr)

	fqDomain := d.cfg.Domain
	suffix := "." + fqDomain
	serverIP := net.ParseIP(d.cfg.NSIP)

	switch {
	case qtype == 2 && qname == fqDomain:
		// NS 查询：返回权威名字服务器
		logger.Debug("DNS NS 响应: %s", qname)
		return buildReply(id, qname, qtype, nil,
			[]string{"ns1." + fqDomain, "ns2." + fqDomain})

	case qtype == 1 && (qname == "ns1."+fqDomain ||
		qname == "ns2."+fqDomain ||
		qname == fqDomain):
		// A 查询：NS 胶水记录或顶点域名
		logger.Debug("DNS A 响应 (glue/apex): %s -> %s", qname, d.cfg.NSIP)
		return buildReply(id, qname, qtype, []net.IP{serverIP}, nil)

	case qtype == 1 && strings.HasSuffix(qname, suffix):
		// A 查询：token 子域名 —— 核心探测路径
		token := strings.TrimSuffix(qname, suffix)

		resolverIP := remoteAddr.String()
		if h, _, err := net.SplitHostPort(resolverIP); err == nil {
			resolverIP = h
		}

		accepted := d.store.Set(token, resolverIP)
		if accepted {
			// token 成功捕获，用 Info 级别记录（有价值的业务事件）
			logger.Info("DNS 探测捕获: token=%s resolverIP=%s", token, resolverIP)
		}
		return buildReply(id, qname, qtype, []net.IP{serverIP}, nil)

	default:
		// 属于白名单区域但不认识的查询类型（如 AAAA、MX 等）→ NXDOMAIN
		logger.Debug("DNS NXDOMAIN: qname=%s qtype=%d", qname, qtype)
		var h [12]byte
		binary.BigEndian.PutUint16(h[0:], id)
		binary.BigEndian.PutUint16(h[2:], 0x8403) // QR=1 AA=1 RCODE=3
		return h[:]
	}
}

// ServeUDP 在 UDP 上监听 DNS 查询，每个请求独立 goroutine 处理。
func (d *DNSServer) ServeUDP() {
	pc, err := net.ListenPacket("udp", d.cfg.DNSPort)
	if err != nil {
		logger.Error("DNS-UDP 监听失败: %v", err)
		os.Exit(1)
	}
	defer pc.Close()
	logger.Info("DNS-UDP 监听 %s", d.cfg.DNSPort)

	buf := make([]byte, 4096)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			logger.Warn("DNS-UDP 读取错误: %v", err)
			continue
		}
		msg := make([]byte, n)
		copy(msg, buf[:n])
		go func(data []byte, a net.Addr) {
			if reply := d.handle(data, a); reply != nil {
				pc.WriteTo(reply, a)
			}
		}(msg, addr)
	}
}

// ServeTCP 在 TCP 上监听 DNS 查询（RFC 1035 §4.2.2，报文前 2 字节为长度前缀）。
func (d *DNSServer) ServeTCP() {
	ln, err := net.Listen("tcp", d.cfg.DNSPort)
	if err != nil {
		logger.Warn("DNS-TCP 监听失败: %v（仅 UDP 模式）", err)
		return
	}
	defer ln.Close()
	logger.Info("DNS-TCP 监听 %s", d.cfg.DNSPort)

	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go d.handleTCPConn(conn)
	}
}

func (d *DNSServer) handleTCPConn(conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))

	var lb [2]byte
	if _, err := conn.Read(lb[:]); err != nil {
		return
	}
	buf := make([]byte, binary.BigEndian.Uint16(lb[:]))
	if _, err := conn.Read(buf); err != nil {
		return
	}
	reply := d.handle(buf, conn.RemoteAddr())
	if reply == nil {
		return
	}
	var rl [2]byte
	binary.BigEndian.PutUint16(rl[:], uint16(len(reply)))
	conn.Write(rl[:])
	conn.Write(reply)
}

// ══════════════════════════════════════════════════════════
//  IP 地理归属查询（GeoLite2，带本地缓存）
// ══════════════════════════════════════════════════════════

type GeoInfo struct {
	Status      string  `json:"status"`
	Country     string  `json:"country"`
	CountryCode string  `json:"countryCode"`
	RegionName  string  `json:"regionName"`
	City        string  `json:"city"`
	ISP         string  `json:"isp"`
	Org         string  `json:"org"`
	Query       string  `json:"query"`
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	ASN         uint    `json:"asn,omitempty"`
	ASNOrg      string  `json:"asnOrg,omitempty"`
}

// getGeoInfoCached 查询 IP 地理归属，优先命中本地缓存。
func getGeoInfoCached(ip string, cache *GeoCache) (*GeoInfo, error) {
	host := ip
	if h, _, err := net.SplitHostPort(ip); err == nil {
		host = h
	}
	if isPrivateIP(host) {
		return &GeoInfo{Query: host, Status: "success", Country: "本地", City: "私有网络"}, nil
	}

	if cached, ok := cache.Get(host); ok {
		logger.Debug("GeoCache 命中: ip=%s", host)
		return cached, nil
	}

	geoDBMu.RLock()
	db := geoDB
	geoDBMu.RUnlock()
	if db == nil || db.db == nil {
		logger.Warn("MaxMind 数据库未初始化: ip=%s", host)
		return nil, fmt.Errorf("MaxMind 数据库未初始化")
	}

	var record maxmindRecord
	err := db.db.Lookup(net.ParseIP(host), &record)
	if err != nil {
		logger.Warn("MaxMind 查询失败: ip=%s err=%v", host, err)
		return nil, err
	}

	info := &GeoInfo{
		Query:       host,
		Status:      "success",
		CountryCode: record.Country.ISOCode,
		City:        record.City.Names.ZhCN,
		Lat:         record.Location.Latitude,
		Lon:         record.Location.Longitude,
	}

	// 处理特殊地区代码（香港、台湾、澳门）
	if mappedCountry, ok := specialRegionCodes[record.Country.ISOCode]; ok {
		info.Country = mappedCountry
	} else {
		info.Country = record.Country.Names.ZhCN
	}

	if len(record.Subdivisions) > 0 {
		info.RegionName = record.Subdivisions[0].Names.ZhCN
	}
	if info.Country == "" {
		info.Country = "未知"
	}
	if info.CountryCode == "" {
		info.CountryCode = "--"
	}
	if info.City == "" {
		info.City = "未知"
	}

	// ASN 查询（独立数据库，失败不影响主流程）
	asnDBMu.RLock()
	adb := asnDB
	asnDBMu.RUnlock()
	if adb != nil && adb.db != nil {
		var ar asnRecord
		if err := adb.db.Lookup(net.ParseIP(host), &ar); err == nil {
			info.ASN = ar.AutonomousSystemNumber
			info.ASNOrg = ar.AutonomousSystemOrganization
		} else {
			logger.Debug("ASN 查询失败: ip=%s err=%v", host, err)
		}
	}

	logger.Debug("GeoInfo 查询成功: ip=%s country=%s city=%s asn=%d org=%s",
		host, info.Country, info.City, info.ASN, info.ASNOrg)
	cache.Set(host, info)
	return info, nil
}

func isPrivateIP(s string) bool {
	ip := net.ParseIP(s)
	if ip == nil {
		return false
	}
	for _, cidr := range []string{
		"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
		"127.0.0.0/8", "::1/128", "fc00::/7",
	} {
		_, n, _ := net.ParseCIDR(cidr)
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ══════════════════════════════════════════════════════════
//  HTTP 服务器
// ══════════════════════════════════════════════════════════

type InfoResponse struct {
	ClientIP    string   `json:"client_ip"`
	ClientGeo   *GeoInfo `json:"client_geo"`
	ResolverIP  string   `json:"resolver_ip,omitempty"`
	ResolverGeo *GeoInfo `json:"resolver_geo,omitempty"`
	Token       string   `json:"token"`
	Found       bool     `json:"found"`
}

// LeakTokenResult 是单个探针 token 的捕获结果。
type LeakTokenResult struct {
	Token       string   `json:"token"`
	Found       bool     `json:"found"`
	ResolverIP  string   `json:"resolver_ip,omitempty"`
	ResolverGeo *GeoInfo `json:"resolver_geo,omitempty"`
}

// LeakResponse 是 /api/leak 的响应结构。
type LeakResponse struct {
	ClientIP        string            `json:"client_ip"`
	ClientGeo       *GeoInfo          `json:"client_geo,omitempty"`
	Results         []LeakTokenResult `json:"results"`
	UniqueResolvers []string          `json:"unique_resolvers"`
	CapturedCount   int               `json:"captured_count"`
	TotalCount      int               `json:"total_count"`
	Leaked          bool              `json:"leaked"`
}

type WebServer struct {
	cfg      *Config
	store    *TokenStore
	geoCache *GeoCache
	traceRL  *traceRateLimiter
}

// getClientIP 从请求中提取真实客户端 IP，兼容反代。
func getClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.SplitN(xff, ",", 2)[0])
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}

// handleInfo 处理 /api/info?token=xxx。
// token 首次命中后立即从 Store 删除，防止重复消费。
func (w *WebServer) handleInfo(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Access-Control-Allow-Origin", "*")
	rw.Header().Set("Content-Type", "application/json")

	clientIP := getClientIP(r)

	token := r.URL.Query().Get("token")
	resp := InfoResponse{ClientIP: clientIP, Token: token}

	if geo, err := getGeoInfoCached(clientIP, w.geoCache); err == nil {
		resp.ClientGeo = geo
	}

	if token != "" {
		if resolverIP, ok := w.store.Get(token); ok {
			resp.Found = true
			resp.ResolverIP = resolverIP
			logger.Info("HTTP 探测结果下发: token=%s clientIP=%s resolverIP=%s",
				token, clientIP, resolverIP)
			if geo, err := getGeoInfoCached(resolverIP, w.geoCache); err == nil {
				resp.ResolverGeo = geo
			}
		} else {
			logger.Debug("HTTP 轮询未命中: token=%s clientIP=%s", token, clientIP)
		}
	}

	json.NewEncoder(rw).Encode(resp)
}

func (w *WebServer) handleIndex(rw http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(rw, r)
		return
	}
	data, err := os.ReadFile("index.html")
	if err != nil {
		logger.Error("读取 index.html 失败: %v", err)
		http.Error(rw, "index.html not found", 500)
		return
	}
	html := strings.ReplaceAll(string(data), "{{.Domain}}", w.cfg.Domain)
	rw.Header().Set("Content-Type", "text/html; charset=utf-8")
	rw.Write([]byte(html))
}

// handleProbe 返回 1×1 透明 PNG，触发浏览器发起 DNS 查询。
func (w *WebServer) handleProbe(rw http.ResponseWriter, r *http.Request) {
	png := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
		0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
		0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
		0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
		0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
		0x42, 0x60, 0x82,
	}
	rw.Header().Set("Access-Control-Allow-Origin", "*")
	rw.Header().Set("Content-Type", "image/png")
	rw.Header().Set("Cache-Control", "no-store")
	rw.Write(png)
}

// handleGeo 查询任意 IP 的地理归属，返回 GeoInfo JSON。
// GET /api/geo?ip=1.2.3.4
func (w *WebServer) handleGeo(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Access-Control-Allow-Origin", "*")

	ip := r.URL.Query().Get("ip")
	if ip == "" {
		ip = getClientIP(r)
	}
	if net.ParseIP(ip) == nil {
		rw.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(rw).Encode(map[string]string{"error": "ip 格式无效"})
		return
	}

	info, err := getGeoInfoCached(ip, w.geoCache)
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(rw).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(rw).Encode(info)
}

// handleLeak 处理 DNS 泄漏检测。
//
// GET /api/leak?tokens=t1,t2,t3...  — 轮询（Peek，不消费 token）
// DELETE /api/leak?tokens=t1,t2,t3... — 检测结束，清理 token
//
// 泄漏判断：捕获到的 resolverIP 中存在多个不同 IP 即判定为泄漏。
func (w *WebServer) handleLeak(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Access-Control-Allow-Origin", "*")
	rw.Header().Set("Content-Type", "application/json")

	tokensParam := r.URL.Query().Get("tokens")
	if tokensParam == "" {
		rw.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(rw).Encode(map[string]string{"error": "tokens 参数不能为空"})
		return
	}

	tokens := strings.Split(tokensParam, ",")
	// 最多接受 10 个探针，防止滥用
	if len(tokens) > 10 {
		tokens = tokens[:10]
	}

	// DELETE 请求：检测结束，清理 token
	if r.Method == http.MethodDelete {
		w.store.Delete(tokens)
		rw.WriteHeader(http.StatusNoContent)
		return
	}

	clientIP := getClientIP(r)
	resp := LeakResponse{
		ClientIP:   clientIP,
		TotalCount: len(tokens),
	}
	if geo, err := getGeoInfoCached(clientIP, w.geoCache); err == nil {
		resp.ClientGeo = geo
	}

	resolverSet := make(map[string]struct{})
	results := make([]LeakTokenResult, 0, len(tokens))

	for _, token := range tokens {
		token = strings.TrimSpace(token)
		result := LeakTokenResult{Token: token}
		if resolverIP, ok := w.store.Peek(token); ok {
			result.Found = true
			result.ResolverIP = resolverIP
			if geo, err := getGeoInfoCached(resolverIP, w.geoCache); err == nil {
				result.ResolverGeo = geo
			}
			resolverSet[resolverIP] = struct{}{}
			resp.CapturedCount++
		}
		results = append(results, result)
	}

	resp.Results = results
	for ip := range resolverSet {
		resp.UniqueResolvers = append(resp.UniqueResolvers, ip)
	}
	resp.Leaked = len(resp.UniqueResolvers) > 1

	json.NewEncoder(rw).Encode(resp)
}

// ══════════════════════════════════════════════════════════
//  流媒体解锁检测
// ══════════════════════════════════════════════════════════

// UnlockResult 记录单个服务的解锁状态。
type UnlockResult struct {
	Service   string `json:"service"`
	Available bool   `json:"available"`
	Region    string `json:"region,omitempty"`
	Note      string `json:"note,omitempty"`
}

// unlockHTTPClient 是解锁检测专用 HTTP 客户端，独立超时、限制重定向次数。
var unlockHTTPClient = &http.Client{
	Timeout: 9 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

// 解锁检测结果缓存（服务器 IP 几乎不变，5 分钟内复用）
var (
	unlockCacheMu   sync.RWMutex
	unlockCacheData []UnlockResult
	unlockCachedAt  time.Time
)

const unlockCacheTTL = 5 * time.Minute

type streamServiceDef struct {
	name    string
	url     string
	checkFn func(status int, finalURL, body string) (available bool, region, note string)
}

// isoToName 将 ISO 3166-1 alpha-2 国家代码转为中文名，未收录则返回原代码。
func isoToName(code string) string {
	if code == "" {
		return ""
	}
	names := map[string]string{
		"US": "美国", "GB": "英国", "CA": "加拿大", "AU": "澳大利亚",
		"JP": "日本", "KR": "韩国", "SG": "新加坡", "HK": "香港",
		"TW": "台湾", "DE": "德国", "FR": "法国", "NL": "荷兰",
		"IT": "意大利", "ES": "西班牙", "PT": "葡萄牙", "SE": "瑞典",
		"NO": "挪威", "FI": "芬兰", "DK": "丹麦", "CH": "瑞士",
		"AT": "奥地利", "BE": "比利时", "PL": "波兰", "CZ": "捷克",
		"TR": "土耳其", "RU": "俄罗斯", "IN": "印度", "BR": "巴西",
		"MX": "墨西哥", "AR": "阿根廷", "CL": "智利", "CO": "哥伦比亚",
		"ZA": "南非", "TH": "泰国", "MY": "马来西亚", "ID": "印度尼西亚",
		"PH": "菲律宾", "VN": "越南", "NZ": "新西兰",
		"SA": "沙特阿拉伯", "AE": "阿联酋", "IL": "以色列",
	}
	if name, ok := names[strings.ToUpper(code)]; ok {
		return name
	}
	return strings.ToUpper(code)
}

// parseCountry 按优先级依次尝试 patterns，从响应体中提取 ISO 国家代码。
func parseCountry(body string, patterns []string) string {
	for _, p := range patterns {
		re := regexp.MustCompile(p)
		if m := re.FindStringSubmatch(body); len(m) > 1 {
			return strings.ToUpper(m[1])
		}
	}
	return ""
}

// streamServiceList 是所有待检测服务的定义列表。
var streamServiceList = []streamServiceDef{
	{
		name: "Netflix",
		url:  "https://www.netflix.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			if status != 200 {
				return false, "", fmt.Sprintf("HTTP %d", status)
			}
			if strings.Contains(body, "not available in your country") ||
				strings.Contains(body, "currently not available") {
				return false, "", "地区不可用"
			}
			code := parseCountry(body, []string{
				`"requestCountry"\s*:\s*\{\s*"id"\s*:\s*"([A-Z]{2})"`,
				`"countryCode"\s*:\s*"([A-Z]{2})"`,
				`"country"\s*:\s*"([A-Z]{2})"`,
			})
			return true, isoToName(code), ""
		},
	},
	{
		name: "YouTube",
		url:  "https://www.youtube.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			if status != 200 {
				return false, "", fmt.Sprintf("HTTP %d", status)
			}
			code := parseCountry(body, []string{
				`"GL"\s*:\s*"([A-Z]{2})"`,
				`"gl"\s*:\s*"([a-zA-Z]{2})"`,
				`INNERTUBE_CONTEXT_GL[" ]*:\s*"([A-Z]{2})"`,
			})
			return true, isoToName(code), ""
		},
	},
	{
		name: "Disney+",
		url:  "https://www.disneyplus.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			if status == 200 {
				if strings.Contains(body, "not available") || strings.Contains(body, "coming soon") {
					return false, "", "地区不可用"
				}
				code := parseCountry(body, []string{
					`"countryCode"\s*:\s*"([A-Z]{2})"`,
					`"country"\s*:\s*"([A-Z]{2})"`,
					`"region"\s*:\s*"([A-Z]{2})"`,
				})
				return true, isoToName(code), ""
			}
			if status == 403 || status == 451 {
				return false, "", "地区封锁"
			}
			return false, "", fmt.Sprintf("HTTP %d", status)
		},
	},
	{
		name: "ChatGPT",
		url:  "https://chatgpt.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			if status == 200 {
				return true, "", ""
			}
			if status == 403 || status == 451 {
				return false, "", "地区封锁"
			}
			return false, "", fmt.Sprintf("HTTP %d", status)
		},
	},
	{
		name: "Spotify",
		url:  "https://open.spotify.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			if status != 200 {
				return false, "", fmt.Sprintf("HTTP %d", status)
			}
			code := parseCountry(body, []string{
				`"country"\s*:\s*"([A-Z]{2})"`,
				`"market"\s*:\s*"([A-Z]{2})"`,
			})
			return true, isoToName(code), ""
		},
	},
	{
		name: "TikTok",
		url:  "https://www.tiktok.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			return status == 200, "", ""
		},
	},
	{
		name: "Twitter/X",
		url:  "https://x.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			return status == 200, "", ""
		},
	},
	{
		name: "GitHub",
		url:  "https://github.com/",
		checkFn: func(status int, finalURL, body string) (bool, string, string) {
			return status == 200, "", ""
		},
	},
}

// doUnlockChecks 并发检测所有服务，按定义顺序返回结果。
func doUnlockChecks() []UnlockResult {
	results := make([]UnlockResult, len(streamServiceList))
	var wg sync.WaitGroup

	for i, svc := range streamServiceList {
		wg.Add(1)
		go func(idx int, s streamServiceDef) {
			defer wg.Done()
			result := UnlockResult{Service: s.name}

			req, err := http.NewRequest("GET", s.url, nil)
			if err != nil {
				result.Note = "请求构建失败"
				results[idx] = result
				return
			}
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
			req.Header.Set("Accept-Language", "en-US,en;q=0.9")
			req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

			resp, err := unlockHTTPClient.Do(req)
			if err != nil {
				result.Note = "连接超时"
				results[idx] = result
				return
			}
			defer resp.Body.Close()

			body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
			result.Available, result.Region, result.Note = s.checkFn(
				resp.StatusCode, resp.Request.URL.String(), string(body),
			)
			results[idx] = result
		}(i, svc)
	}
	wg.Wait()
	return results
}

// handleUnlock 返回流媒体解锁检测结果，命中缓存时直接返回，?refresh=1 强制刷新。
// GET /api/unlock
func (w *WebServer) handleUnlock(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Access-Control-Allow-Origin", "*")

	forceRefresh := r.URL.Query().Get("refresh") == "1"

	unlockCacheMu.RLock()
	cacheHit := unlockCacheData != nil && !forceRefresh && time.Since(unlockCachedAt) < unlockCacheTTL
	unlockCacheMu.RUnlock()

	if cacheHit {
		unlockCacheMu.RLock()
		defer unlockCacheMu.RUnlock()
		json.NewEncoder(rw).Encode(map[string]any{
			"results":    unlockCacheData,
			"checked_at": unlockCachedAt.Format(time.RFC3339),
			"cached":     true,
		})
		return
	}

	logger.Info("流媒体解锁检测开始，来自 %s", getClientIP(r))
	results := doUnlockChecks()

	unlockCacheMu.Lock()
	unlockCacheData = results
	unlockCachedAt = time.Now()
	unlockCacheMu.Unlock()

	json.NewEncoder(rw).Encode(map[string]any{
		"results":    results,
		"checked_at": unlockCachedAt.Format(time.RFC3339),
		"cached":     false,
	})
}

// handleStats 返回运行状态（建议生产环境加 IP 鉴权）。
func (w *WebServer) handleStats(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"token_store_size": w.store.Len(),
		"allowed_zones":    w.cfg.AllowedZones,
		"log_level":        levelName[w.cfg.LogLevel],
		"time":             time.Now().Format(time.RFC3339),
	})
}

// ══════════════════════════════════════════════════════════
//  路由追踪（Traceroute）
// ══════════════════════════════════════════════════════════

// TracerouteHop 表示一跳的探测结果
type TracerouteHop struct {
	Hop     int       `json:"hop"`
	IP      string    `json:"ip"`
	RTTs    []float64 `json:"rtts"`    // 毫秒，-1 表示超时
	AvgRTT  float64   `json:"avg_rtt"` // 成功探测的平均 RTT，全部超时为 -1
	Geo     *GeoInfo  `json:"geo,omitempty"`
	IsDest  bool      `json:"is_dest"`
	Timeout bool      `json:"timeout"` // 3 次探测全部超时
}

// TracerouteResult 最终汇总结果（用于 done 事件）
type TracerouteResult struct {
	Target     string          `json:"target"`
	ResolvedIP string          `json:"resolved_ip"`
	Hops       []TracerouteHop `json:"hops"`
	Done       bool            `json:"done"`
	Error      string          `json:"error,omitempty"`
}

// ---------- 速率限制 ----------

type traceRateLimiter struct {
	mu      sync.Mutex
	counts  map[string]int
	resetAt time.Time
}

func newTraceRateLimiter() *traceRateLimiter {
	return &traceRateLimiter{counts: make(map[string]int), resetAt: time.Now().Add(time.Minute)}
}

const traceRateMaxPerIP = 5

func (rl *traceRateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	if now.After(rl.resetAt) {
		rl.counts = make(map[string]int)
		rl.resetAt = now.Add(time.Minute)
	}
	if rl.counts[ip] >= traceRateMaxPerIP {
		return false
	}
	rl.counts[ip]++
	return true
}

// ---------- 核心 traceroute 实现 ----------

// runTraceroute 执行 ICMP traceroute，逐跳将结果发送至 hopCh。
func runTraceroute(ctx context.Context, target string, geoCache *GeoCache, hopCh chan<- TracerouteHop) {
	defer close(hopCh)

	// 解析目标地址
	ip := net.ParseIP(target)
	if ip == nil {
		// 当作域名解析
		addrs, err := net.DefaultResolver.LookupHost(ctx, target)
		if err != nil {
			logger.Warn("traceroute: 域名解析失败 %s: %v", target, err)
			return
		}
		for _, a := range addrs {
			if parsed := net.ParseIP(a); parsed != nil && parsed.To4() != nil {
				ip = parsed
				break
			}
		}
		if ip == nil {
			logger.Warn("traceroute: 无法获取 IPv4 地址: %s", target)
			return
		}
	}

	if ip.To4() == nil {
		logger.Warn("traceroute: 仅支持 IPv4: %s", ip)
		return
	}

	destIP := ip.To4().String()
	logger.Info("traceroute: 开始追踪 %s (%s)", target, destIP)

	// 打开 ICMP 监听
	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		logger.Error("traceroute: 无法打开 ICMP 套接字: %v", err)
		return
	}
	defer conn.Close()

	pconn := ipv4.NewPacketConn(conn)
	// 会话唯一 ID，避免并发追踪冲突
	echoID := rand.Intn(0xffff)

	const (
		maxHops       = 30
		probesPerHop  = 3
		probeTimeout  = 2 * time.Second
		maxConsecFail = 3
	)

	consecTimeout := 0

	for ttl := 1; ttl <= maxHops; ttl++ {
		select {
		case <-ctx.Done():
			logger.Info("traceroute: 上下文取消，停止追踪")
			return
		default:
		}

		if err := pconn.SetTTL(ttl); err != nil {
			logger.Error("traceroute: 设置 TTL=%d 失败: %v", ttl, err)
			return
		}

		hop := TracerouteHop{Hop: ttl, RTTs: make([]float64, probesPerHop)}
		hopIP := ""
		allTimeout := true
		reachedDest := false

		for p := 0; p < probesPerHop; p++ {
			seq := ttl*probesPerHop + p

			// 构造 ICMP Echo Request
			msg := &icmp.Message{
				Type: ipv4.ICMPTypeEcho,
				Code: 0,
				Body: &icmp.Echo{
					ID:   echoID,
					Seq:  seq,
					Data: []byte("NETTRACE"),
				},
			}
			wb, err := msg.Marshal(nil)
			if err != nil {
				hop.RTTs[p] = -1
				continue
			}

			dst := &net.IPAddr{IP: net.ParseIP(destIP)}
			start := time.Now()
			if _, err := conn.WriteTo(wb, dst); err != nil {
				hop.RTTs[p] = -1
				continue
			}

			// 等待匹配的响应
			_ = conn.SetReadDeadline(time.Now().Add(probeTimeout))
			buf := make([]byte, 1500)
			matched := false

			for !matched {
				n, peer, err := conn.ReadFrom(buf)
				if err != nil {
					// 超时或其他错误
					break
				}
				rtt := time.Since(start)

				parsed, err := icmp.ParseMessage(1, buf[:n]) // protocol 1 = ICMP
				if err != nil {
					continue
				}

				switch parsed.Type {
				case ipv4.ICMPTypeEchoReply:
					// 目标回复
					if echo, ok := parsed.Body.(*icmp.Echo); ok && echo.ID == echoID && echo.Seq == seq {
						hop.RTTs[p] = float64(rtt.Microseconds()) / 1000.0
						hopIP = peer.String()
						allTimeout = false
						reachedDest = true
						matched = true
					}
				case ipv4.ICMPTypeTimeExceeded:
					// 中间路由器返回，需要从内嵌数据提取原始 Echo 来匹配
					body := parsed.Body.(*icmp.TimeExceeded)
					if len(body.Data) >= 28 { // IP header(20) + ICMP header(8)
						innerData := body.Data
						// 跳过内嵌 IP 头部（通常 20 字节，但 IHL 可变）
						ihl := int(innerData[0]&0x0f) * 4
						if ihl >= 20 && len(innerData) >= ihl+8 {
							icmpPayload := innerData[ihl:]
							innerID := int(icmpPayload[4])<<8 | int(icmpPayload[5])
							innerSeq := int(icmpPayload[6])<<8 | int(icmpPayload[7])
							if innerID == echoID && innerSeq == seq {
								hop.RTTs[p] = float64(rtt.Microseconds()) / 1000.0
								hopIP = peer.String()
								allTimeout = false
								matched = true
							}
						}
					}
				}
			}

			if !matched {
				hop.RTTs[p] = -1
			}
		}

		hop.IP = hopIP
		hop.Timeout = allTimeout
		hop.IsDest = reachedDest

		// 计算平均 RTT
		if allTimeout {
			hop.AvgRTT = -1
		} else {
			var sum float64
			var cnt int
			for _, r := range hop.RTTs {
				if r >= 0 {
					sum += r
					cnt++
				}
			}
			if cnt > 0 {
				hop.AvgRTT = math.Round(sum/float64(cnt)*100) / 100
			} else {
				hop.AvgRTT = -1
			}
		}

		// Geo 查询
		if hopIP != "" {
			geo, err := getGeoInfoCached(hopIP, geoCache)
			if err == nil {
				hop.Geo = geo
			}
		}

		// 发送到通道
		select {
		case hopCh <- hop:
		case <-ctx.Done():
			return
		}

		if reachedDest {
			logger.Info("traceroute: 到达目标 %s，TTL=%d", destIP, ttl)
			return
		}

		if allTimeout {
			consecTimeout++
		} else {
			consecTimeout = 0
		}
		if consecTimeout >= maxConsecFail {
			logger.Info("traceroute: 连续 %d 跳超时，停止追踪", maxConsecFail)
			return
		}
	}

	logger.Info("traceroute: 达到最大跳数 %d", maxHops)
}

// ---------- SSE 接口 ----------

// handleTrace 处理 /api/trace?target=<ip_or_domain> 请求，以 SSE 流式返回每一跳。
func (w *WebServer) handleTrace(rw http.ResponseWriter, r *http.Request) {
	target := strings.TrimSpace(r.URL.Query().Get("target"))
	if target == "" {
		http.Error(rw, `{"error":"missing target parameter"}`, http.StatusBadRequest)
		return
	}

	// 简单校验：只允许域名或 IP 格式
	validTarget := regexp.MustCompile(`^[a-zA-Z0-9.\-:]+$`)
	if !validTarget.MatchString(target) {
		http.Error(rw, `{"error":"invalid target format"}`, http.StatusBadRequest)
		return
	}

	// 如果是 IP，拒绝私有地址
	if ip := net.ParseIP(target); ip != nil {
		if isPrivateIP(target) {
			http.Error(rw, `{"error":"private IP not allowed"}`, http.StatusForbidden)
			return
		}
	}

	// 速率限制
	clientIP := getClientIP(r)
	if !w.traceRL.Allow(clientIP) {
		http.Error(rw, `{"error":"rate limit exceeded, try again later"}`, http.StatusTooManyRequests)
		return
	}

	// 确保支持 Flush
	flusher, ok := rw.(http.Flusher)
	if !ok {
		http.Error(rw, `{"error":"streaming not supported"}`, http.StatusInternalServerError)
		return
	}

	// SSE 头
	rw.Header().Set("Content-Type", "text/event-stream")
	rw.Header().Set("Cache-Control", "no-cache")
	rw.Header().Set("Connection", "keep-alive")
	rw.Header().Set("Access-Control-Allow-Origin", "*")

	// 总超时 60 秒
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	hopCh := make(chan TracerouteHop, 5)

	// 解析目标 IP（用于最终结果）
	resolvedIP := target
	if net.ParseIP(target) == nil {
		addrs, err := net.DefaultResolver.LookupHost(ctx, target)
		if err != nil {
			errJSON, _ := json.Marshal(TracerouteResult{Target: target, Done: true, Error: "DNS resolution failed: " + err.Error()})
			fmt.Fprintf(rw, "data: %s\n\n", errJSON)
			flusher.Flush()
			return
		}
		for _, a := range addrs {
			if parsed := net.ParseIP(a); parsed != nil && parsed.To4() != nil {
				resolvedIP = a
				break
			}
		}
		// 解析后再次检查是否为私有 IP
		if isPrivateIP(resolvedIP) {
			errJSON, _ := json.Marshal(TracerouteResult{Target: target, Done: true, Error: "resolved to private IP, not allowed"})
			fmt.Fprintf(rw, "data: %s\n\n", errJSON)
			flusher.Flush()
			return
		}
	}

	logger.Info("traceroute: 客户端 %s 请求追踪 %s (%s)", clientIP, target, resolvedIP)

	go runTraceroute(ctx, resolvedIP, w.geoCache, hopCh)

	var hops []TracerouteHop
	for hop := range hopCh {
		hops = append(hops, hop)
		data, _ := json.Marshal(hop)
		fmt.Fprintf(rw, "data: %s\n\n", data)
		flusher.Flush()
	}

	// 发送最终汇总
	result := TracerouteResult{
		Target:     target,
		ResolvedIP: resolvedIP,
		Hops:       hops,
		Done:       true,
	}
	data, _ := json.Marshal(result)
	fmt.Fprintf(rw, "data: %s\n\n", data)
	flusher.Flush()
}

// ══════════════════════════════════════════════════════════
//  HTTP 指纹
// ══════════════════════════════════════════════════════════

// handleHeaders 返回服务端收到的 HTTP 请求头及连接信息。
func (w *WebServer) handleHeaders(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Access-Control-Allow-Origin", "*")
	rw.Header().Set("Content-Type", "application/json")

	clientIP := getClientIP(r)

	// Collect all headers in order
	headers := make([]map[string]string, 0, len(r.Header))
	for name, values := range r.Header {
		for _, v := range values {
			headers = append(headers, map[string]string{"name": name, "value": v})
		}
	}

	// Sort headers by name for consistent output
	sort.Slice(headers, func(i, j int) bool {
		return headers[i]["name"] < headers[j]["name"]
	})

	resp := map[string]any{
		"client_ip":   clientIP,
		"method":      r.Method,
		"protocol":    r.Proto,
		"host":        r.Host,
		"uri":         r.RequestURI,
		"remote_addr": r.RemoteAddr,
		"headers":     headers,
		"tls":         r.TLS != nil,
	}

	json.NewEncoder(rw).Encode(resp)
}

// ══════════════════════════════════════════════════════════
//  程序入口
// ══════════════════════════════════════════════════════════

func main() {
	cfg := buildConfig()

	// 初始化全局 logger（所有模块共享）
	logger = newLogger(cfg.LogLevel, os.Stdout)

	logger.Info("=== DNS Detector 启动 ===")
	logger.Info("域名        : %s", cfg.Domain)
	logger.Info("服务IP      : %s", cfg.NSIP)
	logger.Info("Web 端口    : %s", cfg.WebPort)
	logger.Info("DNS 端口    : %s", cfg.DNSPort)
	logger.Info("日志等级    : %s", levelName[cfg.LogLevel])
	logger.Info("DNS 白名单  : %v", cfg.AllowedZones)
	logger.Info("Token TTL   : %v", tokenTTL)
	logger.Info("速率限制    : %d token/min/resolverIP", rateMaxPerIP)
	logger.Info("Geo 缓存TTL : %v", geoCacheTTL)
	logger.Info("City 数据库 : %s", cfg.GeoDBPath)
	logger.Info("ASN 数据库  : %s", cfg.ASNDBPath)
	if cfg.GeoLicenseKey != "" {
		logger.Info("MaxMind Key : 已设置（自动下载/每日更新已启用）")
	} else {
		logger.Info("MaxMind Key : 未设置（依赖本地已有数据库文件）")
	}

	// 初始化 City 数据库（文件不存在时自动下载）
	if err := initCityDB(cfg.GeoDBPath, cfg.GeoLicenseKey); err != nil {
		logger.Error("City 数据库初始化失败: %v", err)
		os.Exit(1)
	}
	defer closeGeoDB()

	// 初始化 ASN 数据库（文件不存在时自动下载，失败仅警告不退出）
	if err := initASNDB(cfg.ASNDBPath, cfg.GeoLicenseKey); err != nil {
		logger.Warn("ASN 数据库初始化失败（ASN 信息将不可用）: %v", err)
	}

	// 启动每日定时更新（City + ASN）
	startGeoUpdater(cfg.GeoDBPath, cfg.ASNDBPath, cfg.GeoLicenseKey)

	store := NewTokenStore()
	geoCache := NewGeoCache()

	dnsServer := &DNSServer{cfg: cfg, store: store}
	go dnsServer.ServeUDP()
	go dnsServer.ServeTCP()

	webServer := &WebServer{cfg: cfg, store: store, geoCache: geoCache, traceRL: newTraceRateLimiter()}
	mux := http.NewServeMux()
	mux.HandleFunc("/", webServer.handleIndex)
	mux.HandleFunc("/api/info", webServer.handleInfo)
	mux.HandleFunc("/probe.png", webServer.handleProbe)
	mux.HandleFunc("/api/stats", webServer.handleStats)
	mux.HandleFunc("/api/geo", webServer.handleGeo)
	mux.HandleFunc("/api/leak", webServer.handleLeak)
	mux.HandleFunc("/api/unlock", webServer.handleUnlock)
	mux.HandleFunc("/api/trace", webServer.handleTrace)
	mux.HandleFunc("/api/headers", webServer.handleHeaders)

	logger.Info("HTTP 开始监听 %s", cfg.WebPort)
	if err := http.ListenAndServe(cfg.WebPort, mux); err != nil {
		logger.Error("HTTP 启动失败: %v", err)
		os.Exit(1)
	}
}
