import { createSignal, Show } from 'solid-js';
import { geoToTags } from '../lib/api';

export default function IPv6Section() {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [btnText, setBtnText] = createSignal('开始检测');
  const [badgeHTML, setBadgeHTML] = createSignal('');
  const [resultsHTML, setResultsHTML] = createSignal('');
  const [preferHTML, setPreferHTML] = createSignal('');
  const [preferVisible, setPreferVisible] = createSignal(false);
  const [noteVisible, setNoteVisible] = createSignal(false);

  async function runIPv6Test() {
    setTesting(true);
    setBtnText('检测中…');
    setBodyVisible(true);
    setBadgeHTML('<span style="color:var(--text-muted);font-size:12px">正在检测…</span>');
    setResultsHTML('');
    setPreferVisible(false);
    setNoteVisible(false);

    let v4ip: string | null = null, v6ip: string | null = null, prefIP: string | null = null;
    let v4geo: any = null, v6geo: any = null;

    const timeout = (ms: number) =>
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

    const fetchIP = async (url: string): Promise<string> => {
      const resp: Response = await Promise.race([
        fetch(url, { cache: 'no-store' }),
        timeout(8000)
      ]) as Response;
      const data = await resp.json();
      return data.ip;
    };

    const [v4result, v6result, prefResult] = await Promise.allSettled([
      fetchIP('https://api4.ipify.org?format=json'),
      fetchIP('https://api6.ipify.org?format=json'),
      fetchIP('https://api64.ipify.org?format=json')
    ]);

    if (v4result.status === 'fulfilled') v4ip = v4result.value;
    if (v6result.status === 'fulfilled') v6ip = v6result.value;
    if (prefResult.status === 'fulfilled') prefIP = prefResult.value;

    const fetchGeo = async (ip: string) => {
      try {
        const resp = await fetch('/api/geo?ip=' + encodeURIComponent(ip));
        return await resp.json();
      } catch { return null; }
    };

    const geoPromises: Promise<void>[] = [];
    if (v4ip) geoPromises.push(fetchGeo(v4ip).then(g => { v4geo = g; }));
    if (v6ip) geoPromises.push(fetchGeo(v6ip).then(g => { v6geo = g; }));
    await Promise.all(geoPromises);

    const hasBoth = v4ip && v6ip;
    const hasV4Only = v4ip && !v6ip;
    const hasV6Only = !v4ip && v6ip;

    if (hasBoth) {
      setBadgeHTML('<div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium mb-3.5 bg-[rgba(63,185,80,0.1)] text-green border border-[rgba(63,185,80,0.25)]">✓ 双栈 Dual Stack — 同时支持 IPv4 和 IPv6</div>');
    } else if (hasV4Only) {
      setBadgeHTML('<div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium mb-3.5 bg-[rgba(227,179,65,0.1)] text-yellow border border-[rgba(227,179,65,0.25)]">⚠ 仅 IPv4 — 未检测到 IPv6 连接</div>');
    } else if (hasV6Only) {
      setBadgeHTML('<div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium mb-3.5 bg-[rgba(88,166,255,0.1)] text-blue border border-[rgba(88,166,255,0.25)]">⚠ 仅 IPv6 — 未检测到 IPv4 连接</div>');
    } else {
      setBadgeHTML('<div class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium mb-3.5 bg-[rgba(248,81,73,0.1)] text-red border border-[rgba(248,81,73,0.2)]">✗ 检测失败 — 无法获取 IP 地址</div>');
    }

    let cardsHTML = '';
    const v4tags = v4geo ? geoToTags(v4geo) : [];
    const v4tagsHTML = v4tags.map(t => `<span class="inline-flex items-center px-[9px] py-[3px] rounded-full text-[11px] border whitespace-nowrap ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue' : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green' : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}">${t.text}</span>`).join('');
    cardsHTML += `<div class="bg-surface2 border rounded-lg px-3.5 py-3 ${v4ip ? 'border-[rgba(63,185,80,0.25)]' : 'border-[rgba(248,81,73,0.15)] opacity-60'}"><div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-1 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full ${v4ip ? 'bg-green' : 'bg-red'}"></span> IPv4</div><div class="font-mono text-[13px] text-text-bright break-all mb-1.5">${v4ip || '不可用'}</div><div class="flex flex-wrap gap-1.5">${v4ip ? v4tagsHTML : ''}</div></div>`;

    const v6tags = v6geo ? geoToTags(v6geo) : [];
    const v6tagsHTML = v6tags.map(t => `<span class="inline-flex items-center px-[9px] py-[3px] rounded-full text-[11px] border whitespace-nowrap ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue' : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green' : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}">${t.text}</span>`).join('');
    cardsHTML += `<div class="bg-surface2 border rounded-lg px-3.5 py-3 ${v6ip ? 'border-[rgba(63,185,80,0.25)]' : 'border-[rgba(248,81,73,0.15)] opacity-60'}"><div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-1 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full ${v6ip ? 'bg-green' : 'bg-red'}"></span> IPv6</div><div class="font-mono text-[13px] text-text-bright break-all mb-1.5">${v6ip || '不可用'}</div><div class="flex flex-wrap gap-1.5">${v6ip ? v6tagsHTML : ''}</div></div>`;

    setResultsHTML(cardsHTML);

    if (hasBoth && prefIP) {
      const isV6Pref = prefIP.includes(':');
      setPreferHTML(`🎯 浏览器偏好: <strong>${isV6Pref ? 'IPv6' : 'IPv4'}</strong>（连接时优先使用 ${isV6Pref ? 'IPv6' : 'IPv4'}）`);
      setPreferVisible(true);
    }

    setNoteVisible(true);
    setTesting(false);
    setBtnText('重新检测');
  }

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-purple">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
          IPv6 双栈检测
        </div>
        <button class="bg-transparent border border-border rounded-md text-purple text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(188,140,255,0.08)] hover:not-disabled:border-[rgba(188,140,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={testing()} onClick={runIPv6Test}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="px-[18px] pb-4">
          <div innerHTML={badgeHTML()}></div>
          <div class="grid grid-cols-2 gap-2.5 max-[500px]:grid-cols-1" innerHTML={resultsHTML()}></div>
          <Show when={preferVisible()}>
            <div class="mt-2.5 text-xs text-text-muted flex items-center gap-1.5" innerHTML={preferHTML()}></div>
          </Show>
          <Show when={noteVisible()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted mt-3 leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>检测通过外部 API 分别探测 IPv4 和 IPv6 连接。若您的网络或浏览器禁用了 IPv6，将显示为不可用。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
