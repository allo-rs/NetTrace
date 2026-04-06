import { createSignal, Show, For } from 'solid-js';

const UNLOCK_SERVICES = [
  { name: 'Netflix',   url: 'https://www.netflix.com/' },
  { name: 'YouTube',   url: 'https://www.youtube.com/' },
  { name: 'Disney+',   url: 'https://www.disneyplus.com/' },
  { name: 'ChatGPT',   url: 'https://chatgpt.com/' },
  { name: 'Spotify',   url: 'https://open.spotify.com/' },
  { name: 'TikTok',    url: 'https://www.tiktok.com/' },
  { name: 'Twitter/X', url: 'https://x.com/' },
  { name: 'GitHub',    url: 'https://github.com/' },
];

interface ServiceResult {
  service: string;
  available: boolean;
  note?: string;
  done: boolean;       // whether check is complete
}

/**
 * Probe single service via no-cors fetch.
 * Any HTTP response (200/403/redirect) → "可访问",
 * network error / DNS failure / firewall → "无法访问",
 * timeout → "连接超时".
 */
async function checkService(svc: { name: string; url: string }): Promise<ServiceResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(svc.url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    return { service: svc.name, available: true, done: true };
  } catch (e: any) {
    clearTimeout(timer);
    return { service: svc.name, available: false, note: e.name === 'AbortError' ? '连接超时' : '无法访问', done: true };
  }
}

export default function UnlockSection() {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [btnText, setBtnText] = createSignal('开始检测');
  const [results, setResults] = createSignal<ServiceResult[]>([]);

  async function runUnlockTest() {
    setTesting(true);
    setBtnText('检测中…');
    setBodyVisible(true);

    // Initialize with loading state
    setResults(UNLOCK_SERVICES.map(s => ({
      service: s.name,
      available: false,
      done: false,
    })));

    // Parallel checks, updating each card as it completes
    await Promise.all(UNLOCK_SERVICES.map((svc, i) =>
      checkService(svc).then(r => {
        setResults(prev => {
          const copy = [...prev];
          copy[i] = r;
          return copy;
        });
      })
    ));

    setTesting(false);
    setBtnText('重新检测');
  }

  return (
    <div class="mt-6 border border-border-muted rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-[13px] bg-surface">
        <div class="flex items-center gap-2 text-[13px] font-medium text-text">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          流媒体 &amp; 网络解锁检测
        </div>
        <button class="px-4 py-1.5 border border-border rounded-md bg-transparent text-text text-xs font-sans cursor-pointer transition-colors duration-200 shrink-0 hover:not-disabled:border-purple hover:not-disabled:text-purple hover:not-disabled:bg-[rgba(188,140,255,0.06)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={testing()} onClick={runUnlockTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div>
          <div class="grid grid-cols-4 gap-2 px-[18px] py-4 pb-3.5 bg-bg border-t border-border-muted max-[600px]:grid-cols-2">
            <For each={results()}>
              {(r) => {
                if (!r.done) {
                  return (
                    <div class="bg-surface border border-border rounded-lg px-[11px] py-2.5 flex flex-col gap-[5px] transition-colors duration-200">
                      <div class="text-xs font-medium text-text whitespace-nowrap overflow-hidden text-ellipsis">{r.service}</div>
                      <div class="flex items-center gap-[5px] text-[11px] text-text-muted">
                        <div class="w-1.5 h-1.5 rounded-full shrink-0 bg-text-muted animate-pulse-dot"></div>
                        <span>检测中</span>
                      </div>
                    </div>
                  );
                }
                const dotCls = r.available ? 'bg-green' : (r.note === '连接超时' ? 'bg-yellow' : 'bg-red');
                const statusText = r.available ? '可访问' : (r.note || '无法访问');
                return (
                  <div class={`bg-surface border rounded-lg px-[11px] py-2.5 flex flex-col gap-[5px] transition-colors duration-200 animate-fade-in ${r.available ? 'border-[rgba(63,185,80,0.25)]' : 'border-[rgba(248,81,73,0.2)]'}`}>
                    <div class="text-xs font-medium text-text whitespace-nowrap overflow-hidden text-ellipsis">{r.service}</div>
                    <div class="flex items-center gap-[5px] text-[11px] text-text-muted">
                      <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${dotCls}`}></div>
                      <span>{statusText}</span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="px-[18px] py-2 pb-3.5 bg-bg text-[11px] text-text-muted flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            检测基于您的浏览器网络（前端直连，无需服务器中转）
          </div>
        </div>
      </Show>
    </div>
  );
}
