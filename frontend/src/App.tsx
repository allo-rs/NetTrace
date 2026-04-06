import { createSignal, onMount, Show, For } from 'solid-js';
import './styles/input.css';
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
    if (leaked.length > 0) { setWebrtcIsWarn(true); setWebrtcStatusText(`⚠ 检测到 ${leaked.length} 个泄漏 IP（与服务器报告不一致）`); leaked.forEach(ip => { tags += `<span class="font-mono text-[11px] px-2 py-[2px] rounded bg-[rgba(248,81,73,0.08)] border border-[rgba(248,81,73,0.3)] text-red">${ip}</span>`; }); } else { setWebrtcStatusText('未检测到 WebRTC 公网 IP 泄漏'); }
    local.forEach(ip => { tags += `<span class="font-mono text-[11px] px-2 py-[2px] rounded bg-surface2 border border-border text-text-muted">${ip}</span>`; });
    if (!tags) tags = '<span style="font-size:11px;color:var(--text-muted)">无本地/公网 IP 暴露</span>';
    setWebrtcIpsHTML(tags);
  }

  function buildRows(pairs: [string, string | null | undefined][]): string {
    return pairs.filter(([, v]) => v).map(([k, v]) => `<div class="flex items-baseline gap-3 py-[5px] border-b border-border-muted text-xs last:border-b-0"><span class="font-mono text-[11px] text-text-muted min-w-[80px] shrink-0">${k}</span><span class="text-text break-all">${v}</span></div>`).join('');
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
    let data: any = null; let clientShown = false; const deadline = Date.now() + DNS_TIMEOUT_MS; await sleep(500);
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`/api/info?token=${token}`); data = await res.json();
        if (!clientShown && data.client_ip) { setClientIP(data.client_ip); setClientGeo(data.client_geo || null); clientShown = true; }
        if (data.found) break;
      } catch (e) { console.warn('[poll] fetch error:', e); }
      const remaining = deadline - Date.now(); if (remaining <= 0) break; await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
    if (!data || !data.found) { try { const res = await fetch(`/api/info?token=${token}`); data = await res.json(); } catch (_) {} }
    if (timerInterval) clearInterval(timerInterval); setProgress(100);
    if (!data) { setStatus('error'); setStatusText('检测失败'); setClientIP('请求失败'); setDnsIP('请求失败'); setRefreshDisabled(false); setRefreshSpin(false); return; }
    setClientIP(data.client_ip || '未知'); setClientGeo(data.client_geo || null);
    if (data.found && data.resolver_ip) { setDnsIP(data.resolver_ip); setDnsGeo(data.resolver_geo || null); setDnsFound(true); } else { setDnsIP(null); setDnsFound(false); }
    setStatus('done'); setStatusText('检测完成'); renderCardDetails(data); setSectionsReady(true); setRefreshDisabled(false); setRefreshSpin(false);
  }

  async function runWebRTCCheck() {
    setWebrtcVisible(true); setWebrtcIsWarn(false); setWebrtcStatusText('检测中…'); setWebrtcIpsHTML('');
    const result = await detectWebRTCLeaks(clientIP());
    renderWebRTCResult(result, clientIP());
  }

  onMount(() => { runDetect(); });

  const CopyIcon = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>);
  const InfoIcon = () => (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>);

  return (
    <main class="max-w-[760px] mx-auto px-5 pb-20">
      <div class="flex items-center justify-between py-4 border-b border-border-muted mb-9">
        <a class="flex items-center gap-2.5 no-underline" href="/"><div class="w-[30px] h-[30px] rounded-md bg-gradient-to-br from-blue to-purple flex items-center justify-center shrink-0"><svg width="16" height="16" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="9" stroke="#fff" stroke-width="1.5" fill="none"/><circle cx="16" cy="16" r="5" stroke="#fff" stroke-width="1" stroke-dasharray="2 2" fill="none"/><circle cx="16" cy="16" r="1.5" fill="#fff"/><line x1="16" y1="7" x2="16" y2="4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="16" y1="28" x2="16" y2="25" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="7" y1="16" x2="4" y2="16" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><line x1="28" y1="16" x2="25" y2="16" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="24" cy="8" r="2.5" fill="#3fb950"/><line x1="21.5" y1="10.5" x2="18" y2="14" stroke="#3fb950" stroke-width="1" stroke-linecap="round" opacity="0.7"/></svg></div><span class="font-mono text-[13px] font-medium text-text-bright tracking-[0.5px]">NetTrace</span></a>
        <div class={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[11px] font-medium border bg-surface transition-colors duration-200 ${status() === 'loading' ? 'text-yellow border-[rgba(227,179,65,0.3)]' : status() === 'done' ? 'text-green border-[rgba(63,185,80,0.3)]' : status() === 'error' ? 'text-red border-[rgba(248,81,73,0.3)]' : 'border-border text-text-muted'}`} aria-live="polite"><span class={`w-1.5 h-1.5 rounded-full bg-current shrink-0 ${status() === 'loading' ? 'animate-pulse-dot' : ''}`}></span><span>{statusText()}</span></div>
      </div>
      <div class="mb-7"><h1 class="text-[clamp(22px,4vw,30px)] font-semibold text-text-bright tracking-tight mb-1.5">IP &amp; DNS 检测</h1><p class="text-[13px] text-text-muted">实时检测您的网络出口 IP 地址与 DNS 解析器位置</p></div>
      <div class="h-0.5 bg-border-muted rounded-[1px] overflow-hidden mb-7"><div class="h-full bg-gradient-to-r from-blue to-purple rounded-[1px] transition-[width] duration-400 ease-in-out" style={{ width: `${progress()}%` }}></div></div>
      <div class="grid grid-cols-2 gap-3 mb-5 max-[560px]:grid-cols-1">
        <div class="bg-surface border border-border rounded-xl p-5 relative transition-colors duration-200 hover:border-[rgba(88,166,255,0.25)] group">
          <div class="flex items-start justify-between mb-3.5"><div class="flex items-center gap-2.5"><div class="w-8 h-8 rounded-[7px] flex items-center justify-center shrink-0 bg-[rgba(88,166,255,0.1)] text-blue"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div><div class="font-mono text-[10px] text-text-muted tracking-[1.5px] uppercase mb-0.5">Client IP</div><div class="text-xs text-text font-medium">您的 IP 地址</div></div></div><button class="opacity-0 bg-transparent border border-border rounded-md px-1.5 py-1 cursor-pointer text-text-muted flex items-center transition-all duration-150 shrink-0 group-hover:opacity-100 hover:text-blue hover:border-[rgba(88,166,255,0.4)]" title="复制 IP 地址" onClick={(e) => copyIP(clientIP(), e.currentTarget)}><CopyIcon /></button></div>
          <div class="font-mono text-[clamp(17px,3vw,23px)] font-medium text-blue tracking-tight mb-3 break-all">{clientIP() === null ? <div class="skeleton h-7 w-[70%]"></div> : clientIP()}</div>
          <div class="flex flex-wrap gap-1.5 min-h-6">{clientIP() === null ? <div class="skeleton h-[18px] w-1/2 mt-1.5"></div> : status() === 'error' ? null : <For each={geoToTags(clientGeo())}>{(t) => <span class={`inline-flex items-center px-[9px] py-[3px] rounded-full text-[11px] border whitespace-nowrap ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue' : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green' : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}`}>{t.text}</span>}</For>}</div>
          <Show when={showClientDetails()}><div class="mt-3.5 pt-3.5 border-t border-border-muted animate-fade-in" innerHTML={clientDetailsHTML()}></div></Show>
        </div>
        <div class="bg-surface border border-border rounded-xl p-5 relative transition-colors duration-200 hover:border-[rgba(88,166,255,0.25)] group">
          <div class="flex items-start justify-between mb-3.5"><div class="flex items-center gap-2.5"><div class="w-8 h-8 rounded-[7px] flex items-center justify-center shrink-0 bg-[rgba(188,140,255,0.1)] text-purple"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></div><div><div class="font-mono text-[10px] text-text-muted tracking-[1.5px] uppercase mb-0.5">DNS Resolver</div><div class="text-xs text-text font-medium">您的 DNS 解析器</div></div></div><button class="opacity-0 bg-transparent border border-border rounded-md px-1.5 py-1 cursor-pointer text-text-muted flex items-center transition-all duration-150 shrink-0 group-hover:opacity-100 hover:text-blue hover:border-[rgba(88,166,255,0.4)]" title="复制 IP 地址" onClick={(e) => copyIP(dnsIP(), e.currentTarget)}><CopyIcon /></button></div>
          <div class="font-mono text-[clamp(17px,3vw,23px)] font-medium text-purple tracking-tight mb-3 break-all">{status() === 'loading' ? <div class="skeleton h-7 w-[70%]"></div> : status() === 'error' ? '请求失败' : dnsFound() ? dnsIP() : <span style="font-size:14px;color:var(--text-muted)">未能捕获</span>}</div>
          <div class="flex flex-wrap gap-1.5 min-h-6">{status() === 'loading' ? <div class="skeleton h-[18px] w-1/2 mt-1.5"></div> : dnsFound() ? <For each={geoToTags(dnsGeo())}>{(t) => <span class={`inline-flex items-center px-[9px] py-[3px] rounded-full text-[11px] border whitespace-nowrap ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue' : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green' : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}`}>{t.text}</span>}</For> : status() === 'done' ? <div class="bg-[rgba(227,179,65,0.06)] border border-[rgba(227,179,65,0.2)] rounded-lg px-[13px] py-2.5 text-xs text-yellow leading-relaxed mt-2.5">未能捕获 DNS 解析器。可能原因：您开启了 <b>DNS over HTTPS</b>（Chrome「使用安全DNS」）、本地 DNS 缓存已命中、或网络策略拦截了对本域名的解析。这属于正常现象，客户端 IP 信息不受影响。</div> : null}</div>
          <Show when={showDnsDetails()}><div class="mt-3.5 pt-3.5 border-t border-border-muted animate-fade-in" innerHTML={dnsDetailsHTML()}></div></Show>
        </div>
      </div>
      <Show when={webrtcVisible()}>
        <div class="mt-3 py-[11px] px-4 bg-surface border border-border rounded-lg flex items-start gap-3 text-xs animate-fade-in"><div class={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${webrtcIsWarn() ? 'bg-[rgba(248,81,73,0.1)] text-red' : 'bg-[rgba(63,185,80,0.1)] text-green'}`}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div><div class="flex-1 min-w-0"><div class="font-mono text-[10px] text-text-muted tracking-[1px] uppercase mb-[3px]">WebRTC Leak</div><div class="text-xs text-text font-medium mb-1">{webrtcStatusText()}</div><div class="flex flex-wrap gap-[5px] mt-1.5" innerHTML={webrtcIpsHTML()}></div></div></div>
      </Show>
      <Show when={!webrtcVisible() && status() === 'done'}>
        <button class="flex items-center gap-1.5 mx-auto mt-3 px-4 py-1.5 bg-transparent border border-border-muted rounded-md text-text-muted text-[11px] font-sans cursor-pointer transition-colors duration-200 hover:border-purple hover:text-purple hover:bg-[rgba(188,140,255,0.06)]" onClick={runWebRTCCheck}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          检测 WebRTC 泄漏
        </button>
      </Show>
      <button class="flex items-center gap-[7px] mx-auto mt-5 px-[22px] py-[9px] bg-transparent border border-border rounded-[7px] text-text text-[13px] font-sans cursor-pointer transition-colors duration-200 hover:border-blue hover:text-blue hover:bg-[rgba(88,166,255,0.06)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={refreshDisabled()} onClick={runDetect}>
        <svg class={refreshSpin() ? 'animate-spin' : ''} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        重新检测
      </button>
      <Show when={sectionsReady()}>
        <TabNav activeTab={activeTab} setActiveTab={setActiveTab} />
        <div class={activeTab() === 'tab-network' ? 'block' : 'hidden'}><LeakSection /><IPv6Section /></div>
        <div class={activeTab() === 'tab-performance' ? 'block' : 'hidden'}><SpeedSection /><TraceSection clientIP={clientIP()} /><DNSBenchSection /></div>
        <div class={activeTab() === 'tab-security' ? 'block' : 'hidden'}><NATSection /><UnlockSection /><IPTypeSection /><FPSection /></div>
      </Show>
      <div class="mt-8 border border-border-muted rounded-[10px] overflow-hidden">
        <button class="w-full flex items-center justify-between px-[18px] py-[13px] bg-surface border-none cursor-pointer text-text text-[13px] font-sans font-medium text-left transition-colors duration-150 hover:bg-surface2" aria-expanded={principleOpen()} onClick={() => setPrincipleOpen(p => !p)}>
          <span class="flex items-center gap-2 text-text"><InfoIcon /> 工作原理</span>
          <svg class={`text-text-muted transition-transform duration-200 shrink-0 ${principleOpen() ? 'rotate-180' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class={`${principleOpen() ? 'block' : 'hidden'} px-5 pt-5 pb-6 bg-bg border-t border-border-muted`}>
          <div class="flex items-stretch overflow-x-auto pb-1 mb-5 max-[560px]:flex-col">
            <div class="flex flex-col items-center flex-1 min-w-[100px] max-[560px]:flex-row max-[560px]:min-w-0 max-[560px]:gap-2.5"><div class="bg-surface border border-border rounded-lg px-2.5 py-3 text-center w-full max-[560px]:text-left max-[560px]:flex max-[560px]:items-center max-[560px]:gap-2.5 max-[560px]:px-3.5 max-[560px]:py-2.5"><div class="flex items-center justify-center mx-auto mb-1.5 text-text-muted max-[560px]:m-0"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div class="text-[11px] text-text font-medium leading-tight">您的浏览器</div><div class="text-[10px] text-text-muted mt-[3px] leading-snug">生成随机 token<br/>触发 DNS 探测</div></div></div>
            <div class="flex items-center px-1 text-text-muted shrink-0 self-center -mt-[18px] max-[560px]:rotate-90 max-[560px]:px-0 max-[560px]:py-[2px] max-[560px]:mt-0 max-[560px]:ml-5"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>
            <div class="flex flex-col items-center flex-1 min-w-[100px] max-[560px]:flex-row max-[560px]:min-w-0 max-[560px]:gap-2.5"><div class="bg-surface border border-border rounded-lg px-2.5 py-3 text-center w-full max-[560px]:text-left max-[560px]:flex max-[560px]:items-center max-[560px]:gap-2.5 max-[560px]:px-3.5 max-[560px]:py-2.5"><div class="flex items-center justify-center mx-auto mb-1.5 text-text-muted max-[560px]:m-0"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg></div><div class="text-[11px] text-text font-medium leading-tight">您的 DNS 解析器</div><div class="text-[10px] text-text-muted mt-[3px] leading-snug">运营商或自定义<br/>递归查询代理</div></div></div>
            <div class="flex items-center px-1 text-text-muted shrink-0 self-center -mt-[18px] max-[560px]:rotate-90 max-[560px]:px-0 max-[560px]:py-[2px] max-[560px]:mt-0 max-[560px]:ml-5"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>
            <div class="flex flex-col items-center flex-1 min-w-[100px] max-[560px]:flex-row max-[560px]:min-w-0 max-[560px]:gap-2.5"><div class="bg-surface border border-border rounded-lg px-2.5 py-3 text-center w-full max-[560px]:text-left max-[560px]:flex max-[560px]:items-center max-[560px]:gap-2.5 max-[560px]:px-3.5 max-[560px]:py-2.5"><div class="flex items-center justify-center mx-auto mb-1.5 text-text-muted max-[560px]:m-0"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg></div><div class="text-[11px] text-text font-medium leading-tight">权威 DNS 服务器</div><div class="text-[10px] text-text-muted mt-[3px] leading-snug">本站服务器<br/>记录解析器 IP</div></div></div>
            <div class="flex items-center px-1 text-text-muted shrink-0 self-center -mt-[18px] max-[560px]:rotate-90 max-[560px]:px-0 max-[560px]:py-[2px] max-[560px]:mt-0 max-[560px]:ml-5"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>
            <div class="flex flex-col items-center flex-1 min-w-[100px] max-[560px]:flex-row max-[560px]:min-w-0 max-[560px]:gap-2.5"><div class="bg-surface border border-border rounded-lg px-2.5 py-3 text-center w-full max-[560px]:text-left max-[560px]:flex max-[560px]:items-center max-[560px]:gap-2.5 max-[560px]:px-3.5 max-[560px]:py-2.5"><div class="flex items-center justify-center mx-auto mb-1.5 text-text-muted max-[560px]:m-0"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><div class="text-[11px] text-text font-medium leading-tight">结果展示</div><div class="text-[10px] text-text-muted mt-[3px] leading-snug">IP 归属地 +<br/>DNS 归属地</div></div></div>
          </div>
          <div class="border-t border-border-muted pt-4">
            <div class="flex gap-3 items-start py-2 border-b border-border-muted text-xs text-text leading-[1.7]"><div class="shrink-0 w-5 h-5 rounded-full bg-surface2 border border-border flex items-center justify-center font-mono text-[10px] text-text-muted mt-0.5">1</div><div>您访问本页面时，前端生成一个唯一随机 <b class="text-text-bright font-medium">token</b>（如 <code class="font-mono text-[11px] bg-surface2 border border-border rounded px-[5px] py-[1px] text-blue">a3fx9k</code>），并尝试加载 <code class="font-mono text-[11px] bg-surface2 border border-border rounded px-[5px] py-[1px] text-blue">&lt;token&gt;.{getDomain()}</code> 下的一张 1×1 透明图片。这迫使浏览器向您的 <b class="text-text-bright font-medium">DNS 解析器</b>（通常由运营商或您手动配置）发起查询。</div></div>
            <div class="flex gap-3 items-start py-2 border-b border-border-muted text-xs text-text leading-[1.7]"><div class="shrink-0 w-5 h-5 rounded-full bg-surface2 border border-border flex items-center justify-center font-mono text-[10px] text-text-muted mt-0.5">2</div><div>您的 DNS 解析器在本地缓存中找不到该域名，便向互联网上的 <b class="text-text-bright font-medium">根域名服务器 → 顶级域服务器 → 本站权威 DNS 服务器</b> 逐级查询（递归解析）。最终查询请求打到本服务器的 <b class="text-text-bright font-medium">UDP/TCP 53 端口</b>。</div></div>
            <div class="flex gap-3 items-start py-2 border-b border-border-muted text-xs text-text leading-[1.7]"><div class="shrink-0 w-5 h-5 rounded-full bg-surface2 border border-border flex items-center justify-center font-mono text-[10px] text-text-muted mt-0.5">3</div><div>本站权威 DNS 服务器收到查询后，从报文中提取 <b class="text-text-bright font-medium">token</b>，并记录 <b class="text-text-bright font-medium">来源 IP</b>（即您的 DNS 解析器地址）。随后返回一个正常的 A 记录响应，TTL 设为 1 秒以防止缓存干扰下次探测。</div></div>
            <div class="flex gap-3 items-start py-2 text-xs text-text leading-[1.7]"><div class="shrink-0 w-5 h-5 rounded-full bg-surface2 border border-border flex items-center justify-center font-mono text-[10px] text-text-muted mt-0.5">4</div><div>前端同时调用 <code class="font-mono text-[11px] bg-surface2 border border-border rounded px-[5px] py-[1px] text-blue">/api/info?token=&lt;token&gt;</code> 接口，后端返回您的 <b class="text-text-bright font-medium">客户端 IP</b>（HTTP 连接来源）以及通过 token 关联到的 <b class="text-text-bright font-medium">DNS 解析器 IP</b>，并通过本地 GeoLite2 数据库查询地理归属信息。</div></div>
          </div>
          <div class="mt-3.5 bg-[rgba(227,179,65,0.05)] border border-[rgba(227,179,65,0.18)] rounded-lg px-3.5 py-[11px] text-xs text-yellow leading-[1.7] flex gap-2.5 items-start">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div><b class="font-semibold">已知局限：</b>若您启用了 <b class="font-semibold">DNS over HTTPS（DoH）</b>（如 Chrome 的"使用安全 DNS"功能），浏览器会将 DNS 查询通过 HTTPS 发送至 Google/Cloudflare 等加密服务器，不再经过传统 53 端口，因此本工具<b class="font-semibold">无法捕获</b>您真实使用的 DoH 服务器地址，仅能显示 DoH 提供商的出口 IP。此外，部分企业内网环境会强制代理所有 DNS 请求，同样可能导致结果与预期不同。</div>
          </div>
        </div>
      </div>
      <footer class="text-center mt-10 text-[11px] text-text-muted font-mono"><p>原理：权威 DNS 服务器探针 + HTTP 反向代理获取真实 IP</p></footer>
    </main>
  );
}
