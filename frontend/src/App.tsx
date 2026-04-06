import { createSignal, onMount, Show, For } from 'solid-js';
import './styles/global.css';
import { getDomain, randToken, sleep, geoToTags, isPrivateIP, DNS_TIMEOUT_MS, POLL_INTERVAL_MS } from './lib/api';
import type { GeoInfo } from './lib/api';
import TabNav from './components/TabNav';
import LeakSection from './components/LeakSection';
import IPv6Section from './components/IPv6Section';
import SpeedSection from './components/SpeedSection';
import TraceSection from './components/TraceSection';
import DNSBenchSection from './components/DNSBenchSection';
import NATSection from './components/NATSection';
import UnlockSection from './components/UnlockSection';
import FPSection from './components/FPSection';
import IPTypeSection from './components/IPTypeSection';

interface WebRTCResult { local: string[]; leaked: string[]; }

export default function App() {
  const [status, setStatus] = createSignal<'loading' | 'done' | 'error'>('loading');
  const [statusText, setStatusText] = createSignal('检测中');
  const [progress, setProgress] = createSignal(0);
  const [refreshDisabled, setRefreshDisabled] = createSignal(true);
  const [refreshSpin, setRefreshSpin] = createSignal(false);
  const [clientIP, setClientIP] = createSignal<string | null>(null);
  const [clientGeo, setClientGeo] = createSignal<GeoInfo | null>(null);
  const [dnsIP, setDnsIP] = createSignal<string | null>(null);
  const [dnsFound, setDnsFound] = createSignal(false);
  const [dnsGeo, setDnsGeo] = createSignal<GeoInfo | null>(null);
  const [showClientDetails, setShowClientDetails] = createSignal(false);
  const [clientDetailsHTML, setClientDetailsHTML] = createSignal('');
  const [showDnsDetails, setShowDnsDetails] = createSignal(false);
  const [dnsDetailsHTML, setDnsDetailsHTML] = createSignal('');
  const [webrtcVisible, setWebrtcVisible] = createSignal(false);
  const [webrtcIsWarn, setWebrtcIsWarn] = createSignal(false);
  const [webrtcStatusText, setWebrtcStatusText] = createSignal('检测中…');
  const [webrtcIpsHTML, setWebrtcIpsHTML] = createSignal('');
  const [sectionsReady, setSectionsReady] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal('tab-network');
  const [principleOpen, setPrincipleOpen] = createSignal(false);
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  async function detectWebRTCLeaks(serverClientIP: string | null): Promise<WebRTCResult | null> {
    if (typeof RTCPeerConnection === 'undefined') return null;
    const ips = new Set<string>();
    return new Promise(resolve => {
      let pc: RTCPeerConnection;
      try { pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }); } catch (_) { resolve(null); return; }
      pc.createDataChannel('');
      const finish = () => { try { pc.close(); } catch (_) {} const local: string[] = [], leaked: string[] = []; for (const ip of ips) { if (isPrivateIP(ip)) local.push(ip); else if (ip !== serverClientIP) leaked.push(ip); } resolve({ local, leaked }); };
      const timer = setTimeout(finish, 5000);
      pc.onicecandidate = e => { if (!e.candidate) { clearTimeout(timer); finish(); return; } const parts = e.candidate.candidate.split(' '); if (parts.length >= 5 && parts[4] !== '0.0.0.0') ips.add(parts[4]!); };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); finish(); });
    });
  }

  function renderWebRTCResult(result: WebRTCResult | null, serverClientIP: string | null) {
    setWebrtcVisible(true);
    if (result === null) { setWebrtcStatusText('WebRTC 已禁用（良好的隐私配置）'); setWebrtcIpsHTML(''); return; }
    const { local, leaked } = result; let tags = '';
    if (leaked.length > 0) { setWebrtcIsWarn(true); setWebrtcStatusText(`⚠ 检测到 ${leaked.length} 个泄漏 IP（与服务器报告不一致）`); leaked.forEach(ip => { tags += `<span class="webrtc-ip-tag leaked">${ip}</span>`; }); } else { setWebrtcStatusText('未检测到 WebRTC 公网 IP 泄漏'); }
    local.forEach(ip => { tags += `<span class="webrtc-ip-tag">${ip}</span>`; });
    if (!tags) tags = '<span style="font-size:11px;color:var(--text-muted)">无本地/公网 IP 暴露</span>';
    setWebrtcIpsHTML(tags);
  }

  function buildRows(pairs: [string, string | null | undefined][]): string {
    return pairs.filter(([, v]) => v).map(([k, v]) => `<div class="detail-row"><span class="detail-key">${k}</span><span class="detail-val">${v}</span></div>`).join('');
  }

  function renderCardDetails(data: any) {
    const cg = data.client_geo;
    if (cg) { const rows = buildRows([['IP 地址', data.client_ip], ['国家', cg.country], ['省份', cg.regionName], ['城市', cg.city], ['运营商', cg.isp], ['坐标', cg.lat && cg.lon ? `${cg.lat.toFixed(4)}, ${cg.lon.toFixed(4)}` : null]]); setClientDetailsHTML(rows); if (rows) setShowClientDetails(true); }
    const rg = data.resolver_geo;
    if (data.found && rg) { const rows = buildRows([['IP 地址', data.resolver_ip], ['国家', rg.country], ['省份', rg.regionName], ['城市', rg.city], ['运营商', rg.isp]]); setDnsDetailsHTML(rows); if (rows) setShowDnsDetails(true); }
  }

  function copyIP(text: string | null, btn: HTMLButtonElement) {
    if (!text || text === '未知' || text === '请求失败' || text === '未能捕获') return;
    navigator.clipboard.writeText(text).then(() => { btn.classList.add('copied'); btn.title = '已复制'; setTimeout(() => { btn.classList.remove('copied'); btn.title = '复制 IP 地址'; }, 1800); }).catch(() => {});
  }

  async function runDetect() {
    setRefreshDisabled(true); setRefreshSpin(true); setStatus('loading'); setStatusText('检测中');
    setClientIP(null); setDnsIP(null); setClientGeo(null); setDnsGeo(null); setDnsFound(false);
    setShowClientDetails(false); setShowDnsDetails(false); setClientDetailsHTML(''); setDnsDetailsHTML('');
    setWebrtcVisible(false); setWebrtcIsWarn(false); setWebrtcIpsHTML(''); setProgress(0);
    let elapsed = 0; if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => { elapsed++; setProgress(Math.min(90, elapsed * (90 / (DNS_TIMEOUT_MS / 1000)))); }, 1000);
    const token = randToken(); const domain = getDomain(); const img = new Image(); img.src = `http://${token}.${domain}/probe.png?t=${Date.now()}`;
    const webrtcPromise = detectWebRTCLeaks(null);
    let data: any = null; const deadline = Date.now() + DNS_TIMEOUT_MS; await sleep(500);
    while (Date.now() < deadline) { try { const res = await fetch(`/api/info?token=${token}`); data = await res.json(); if (data.found) break; } catch (e) { console.warn('[poll] fetch error:', e); } const remaining = deadline - Date.now(); if (remaining <= 0) break; await sleep(Math.min(POLL_INTERVAL_MS, remaining)); }
    if (!data || !data.found) { try { const res = await fetch(`/api/info?token=${token}`); data = await res.json(); } catch (_) {} }
    if (timerInterval) clearInterval(timerInterval); setProgress(100);
    const webrtcResult = await webrtcPromise; const clientIPForWebRTC = data ? data.client_ip : null;
    if (webrtcResult && clientIPForWebRTC) { webrtcResult.leaked = webrtcResult.leaked.filter(ip => ip !== clientIPForWebRTC); }
    renderWebRTCResult(webrtcResult, clientIPForWebRTC);
    if (!data) { setStatus('error'); setStatusText('检测失败'); setClientIP('请求失败'); setDnsIP('请求失败'); setRefreshDisabled(false); setRefreshSpin(false); return; }
    setClientIP(data.client_ip || '未知'); setClientGeo(data.client_geo || null);
    if (data.found && data.resolver_ip) { setDnsIP(data.resolver_ip); setDnsGeo(data.resolver_geo || null); setDnsFound(true); } else { setDnsIP(null); setDnsFound(false); }
    setStatus('done'); setStatusText('检测完成'); renderCardDetails(data); setSectionsReady(true); setRefreshDisabled(false); setRefreshSpin(false);
  }

  onMount(() => { runDetect(); });

  const CopyIcon = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>);
  const InfoIcon = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>);

  return (
    <main class="page">
      <div class="topbar">
        <a class="brand" href="/"><div class="brand-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div><span class="brand-name">NetTrace</span></a>
        <div class={`status-badge ${status()}`} aria-live="polite"><span class="badge-dot"></span><span>{statusText()}</span></div>
      </div>
      <div class="hero"><h1>IP &amp; DNS 检测</h1><p class="subtitle">实时检测您的网络出口 IP 地址与 DNS 解析器位置</p></div>
      <div class="progress-bar-wrap"><div id="progressBar" style={{ width: `${progress()}%` }}></div></div>
      <div class="cards">
        <div class="card">
          <div class="card-header"><div class="card-header-left"><div class="card-icon ip"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div><div class="card-label">Client IP</div><div class="card-title">您的 IP 地址</div></div></div><button class="copy-btn" title="复制 IP 地址" onClick={(e) => copyIP(clientIP(), e.currentTarget)}><CopyIcon /></button></div>
          <div class="ip-value c-blue">{clientIP() === null ? <div class="skeleton h-lg"></div> : clientIP()}</div>
          <div class="tags">{clientIP() === null ? <div class="skeleton h-sm"></div> : status() === 'error' ? null : <For each={geoToTags(clientGeo())}>{(t) => <span class={`tag ${t.cls}`}>{t.text}</span>}</For>}</div>
          <Show when={showClientDetails()}><div class="card-details fade-in" innerHTML={clientDetailsHTML()}></div></Show>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-header-left"><div class="card-icon dns"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></div><div><div class="card-label">DNS Resolver</div><div class="card-title">您的 DNS 解析器</div></div></div><button class="copy-btn" title="复制 IP 地址" onClick={(e) => copyIP(dnsIP(), e.currentTarget)}><CopyIcon /></button></div>
          <div class="ip-value c-purple">{status() === 'loading' ? <div class="skeleton h-lg"></div> : status() === 'error' ? '请求失败' : dnsFound() ? dnsIP() : <span style="font-size:14px;color:var(--text-muted)">未能捕获</span>}</div>
          <div class="tags">{status() === 'loading' ? <div class="skeleton h-sm"></div> : dnsFound() ? <For each={geoToTags(dnsGeo())}>{(t) => <span class={`tag ${t.cls}`}>{t.text}</span>}</For> : status() === 'done' ? <div class="notice">未能捕获 DNS 解析器。可能原因：您开启了 <b>DNS over HTTPS</b>（Chrome「使用安全DNS」）、本地 DNS 缓存已命中、或网络策略拦截了对本域名的解析。这属于正常现象，客户端 IP 信息不受影响。</div> : null}</div>
          <Show when={showDnsDetails()}><div class="card-details fade-in" innerHTML={dnsDetailsHTML()}></div></Show>
        </div>
      </div>
      <Show when={webrtcVisible()}>
        <div class="webrtc-row fade-in"><div class={`webrtc-icon ${webrtcIsWarn() ? 'warn' : ''}`}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div><div class="webrtc-content"><div class="webrtc-label">WebRTC Leak</div><div class="webrtc-status">{webrtcStatusText()}</div><div class="webrtc-ips" innerHTML={webrtcIpsHTML()}></div></div></div>
      </Show>
      <button class="btn-refresh" disabled={refreshDisabled()} onClick={runDetect}>
        <svg class={refreshSpin() ? 'spin' : ''} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        重新检测
      </button>
      <Show when={sectionsReady()}>
        <TabNav activeTab={activeTab} setActiveTab={setActiveTab} />
        <div class={`tab-panel ${activeTab() === 'tab-network' ? 'active' : ''}`}><LeakSection /><IPv6Section /></div>
        <div class={`tab-panel ${activeTab() === 'tab-performance' ? 'active' : ''}`}><SpeedSection /><TraceSection clientIP={clientIP()} /><DNSBenchSection /></div>
        <div class={`tab-panel ${activeTab() === 'tab-security' ? 'active' : ''}`}><NATSection /><UnlockSection /><IPTypeSection /><FPSection /></div>
      </Show>
      <div class="principle">
        <button class="principle-toggle" aria-expanded={principleOpen()} onClick={() => setPrincipleOpen(p => !p)}>
          <span class="principle-toggle-left"><InfoIcon /> 工作原理</span>
          <svg class="principle-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class={`principle-body ${principleOpen() ? 'open' : ''}`}>
          <div class="flow">
            <div class="flow-step"><div class="flow-box"><div class="flow-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div class="flow-label">您的浏览器</div><div class="flow-sub">生成随机 token<br/>触发 DNS 探测</div></div></div>
            <div class="flow-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>
            <div class="flow-step"><div class="flow-box"><div class="flow-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></div><div class="flow-label">您的 DNS 解析器</div><div class="flow-sub">运营商或自定义<br/>递归查询代理</div></div></div>
            <div class="flow-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>
            <div class="flow-step"><div class="flow-box"><div class="flow-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg></div><div class="flow-label">权威 DNS 服务器</div><div class="flow-sub">本站服务器<br/>记录解析器 IP</div></div></div>
            <div class="flow-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>
            <div class="flow-step"><div class="flow-box"><div class="flow-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><div class="flow-label">结果展示</div><div class="flow-sub">IP 归属地 +<br/>DNS 归属地</div></div></div>
          </div>
          <div class="desc-list">
            <div class="desc-item"><div class="desc-num">1</div><div class="desc-text">您访问本页面时，前端生成一个唯一随机 <b>token</b>（如 <code>a3fx9k</code>），并尝试加载 <code>&lt;token&gt;.{getDomain()}</code> 下的一张 1×1 透明图片。这迫使浏览器向您的 <b>DNS 解析器</b>（通常由运营商或您手动配置）发起查询。</div></div>
            <div class="desc-item"><div class="desc-num">2</div><div class="desc-text">您的 DNS 解析器在本地缓存中找不到该域名，便向互联网上的 <b>根域名服务器 → 顶级域服务器 → 本站权威 DNS 服务器</b> 逐级查询（递归解析）。最终查询请求打到本服务器的 <b>UDP/TCP 53 端口</b>。</div></div>
            <div class="desc-item"><div class="desc-num">3</div><div class="desc-text">本站权威 DNS 服务器收到查询后，从报文中提取 <b>token</b>，并记录 <b>来源 IP</b>（即您的 DNS 解析器地址）。随后返回一个正常的 A 记录响应，TTL 设为 1 秒以防止缓存干扰下次探测。</div></div>
            <div class="desc-item"><div class="desc-num">4</div><div class="desc-text">前端同时调用 <code>/api/info?token=&lt;token&gt;</code> 接口，后端返回您的 <b>客户端 IP</b>（HTTP 连接来源）以及通过 token 关联到的 <b>DNS 解析器 IP</b>，并通过本地 GeoLite2 数据库查询地理归属信息。</div></div>
          </div>
          <div class="limit-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div><b>已知局限：</b>若您启用了 <b>DNS over HTTPS（DoH）</b>（如 Chrome 的"使用安全 DNS"功能），浏览器会将 DNS 查询通过 HTTPS 发送至 Google/Cloudflare 等加密服务器，不再经过传统 53 端口，因此本工具<b>无法捕获</b>您真实使用的 DoH 服务器地址，仅能显示 DoH 提供商的出口 IP。此外，部分企业内网环境会强制代理所有 DNS 请求，同样可能导致结果与预期不同。</div>
          </div>
        </div>
      </div>
      <footer><p>原理：权威 DNS 服务器探针 + HTTP 反向代理获取真实 IP</p></footer>
    </main>
  );
}
