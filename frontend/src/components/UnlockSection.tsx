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
    <div class="leak-section">
      <div class="leak-header">
        <div class="leak-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--blue)">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          流媒体 &amp; 网络解锁检测
        </div>
        <button class="btn-leak" disabled={testing()} onClick={runUnlockTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div>
          <div class="unlock-grid">
            <For each={results()}>
              {(r) => {
                if (!r.done) {
                  return (
                    <div class="unlock-card">
                      <div class="unlock-svc">{r.service}</div>
                      <div class="unlock-status">
                        <div class="unlock-dot loading"></div>
                        <span>检测中</span>
                      </div>
                    </div>
                  );
                }
                const dotClass = r.available ? 'ok' : (r.note === '连接超时' ? 'timeout' : 'fail');
                const statusText = r.available ? '可访问' : (r.note || '无法访问');
                return (
                  <div class={`unlock-card ${r.available ? 'ok' : 'fail'} fade-in`}>
                    <div class="unlock-svc">{r.service}</div>
                    <div class="unlock-status">
                      <div class={`unlock-dot ${dotClass}`}></div>
                      <span>{statusText}</span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="unlock-note">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            检测基于您的浏览器网络（前端直连，无需服务器中转）
          </div>
        </div>
      </Show>
    </div>
  );
}
