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
      setBadgeHTML('<div class="ipv6-badge dual">✓ 双栈 Dual Stack — 同时支持 IPv4 和 IPv6</div>');
    } else if (hasV4Only) {
      setBadgeHTML('<div class="ipv6-badge v4only">⚠ 仅 IPv4 — 未检测到 IPv6 连接</div>');
    } else if (hasV6Only) {
      setBadgeHTML('<div class="ipv6-badge v6only">⚠ 仅 IPv6 — 未检测到 IPv4 连接</div>');
    } else {
      setBadgeHTML('<div class="ipv6-badge fail">✗ 检测失败 — 无法获取 IP 地址</div>');
    }

    let cardsHTML = '';
    const v4tags = v4geo ? geoToTags(v4geo) : [];
    const v4tagsHTML = v4tags.map(t => `<span class="tag ${t.cls}">${t.text}</span>`).join('');
    cardsHTML += `<div class="ipv6-card ${v4ip ? 'ok' : 'na'}"><div class="ipv6-card-label"><span class="dot ${v4ip ? 'ok' : 'na'}"></span> IPv4</div><div class="ipv6-card-ip">${v4ip || '不可用'}</div><div class="ipv6-card-tags">${v4ip ? v4tagsHTML : ''}</div></div>`;

    const v6tags = v6geo ? geoToTags(v6geo) : [];
    const v6tagsHTML = v6tags.map(t => `<span class="tag ${t.cls}">${t.text}</span>`).join('');
    cardsHTML += `<div class="ipv6-card ${v6ip ? 'ok' : 'na'}"><div class="ipv6-card-label"><span class="dot ${v6ip ? 'ok' : 'na'}"></span> IPv6</div><div class="ipv6-card-ip">${v6ip || '不可用'}</div><div class="ipv6-card-tags">${v6ip ? v6tagsHTML : ''}</div></div>`;

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
    <div class="ipv6-section">
      <div class="ipv6-header">
        <div class="ipv6-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--purple)">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
          IPv6 双栈检测
        </div>
        <button class="btn-ipv6" disabled={testing()} onClick={runIPv6Test}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="ipv6-body">
          <div innerHTML={badgeHTML()}></div>
          <div class="ipv6-results" innerHTML={resultsHTML()}></div>
          <Show when={preferVisible()}>
            <div class="ipv6-prefer" innerHTML={preferHTML()}></div>
          </Show>
          <Show when={noteVisible()}>
            <div class="ipv6-note">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px">
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
