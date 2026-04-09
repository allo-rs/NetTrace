import { createSignal, Show, For } from 'solid-js';

interface Site {
  name: string;
  domain: string;
  tags: string[];
}

// 仅保留 Cloudflare 托管站点，通过 cdn-cgi/trace 获取真实出口 IP
const SITES: Site[] = [
  { name: 'Cloudflare 中国',  domain: 'cloudflare.cn',     tags: ['国内']           },
  { name: 'TikTok',          domain: 'www.tiktok.com',    tags: ['国际', 'Dev']    },
  { name: 'Discord',         domain: 'discord.com',       tags: ['国际', 'Social'] },
  { name: 'X.com',           domain: 'x.com',             tags: ['国际', 'Social'] },
  { name: 'medium.com',      domain: 'medium.com',        tags: ['国际', 'Social'] },
  { name: 'anthropic.com',   domain: 'anthropic.com',     tags: ['国际', 'AI']     },
  { name: 'claude.ai',       domain: 'claude.ai',         tags: ['国际', 'AI']     },
  { name: 'ChatGPT',         domain: 'chatgpt.com',       tags: ['国际', 'AI']     },
  { name: 'openai.com',      domain: 'openai.com',        tags: ['国际', 'AI']     },
  { name: 'sora.com',        domain: 'sora.com',          tags: ['国际', 'AI']     },
  { name: 'grok.com',        domain: 'grok.com',          tags: ['国际', 'AI']     },
  { name: 'perplexity.ai',   domain: 'www.perplexity.ai', tags: ['国际', 'AI']     },
];

interface GeoInfo {
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  isp?: string;
  org?: string;
}

interface SiteResult extends Site {
  ip: string;
  geo: GeoInfo | null;
  error?: string;
  done: boolean;
}

function countryFlag(code?: string): string {
  if (!code || code.length !== 2) return '';
  return code.toUpperCase().replace(/[A-Z]/g, c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

function tagClass(tag: string): string {
  switch (tag) {
    case '国内':   return 'bg-[rgba(63,185,80,0.12)] text-[#3fb950] border border-[rgba(63,185,80,0.25)]';
    case '国际':   return 'bg-[rgba(88,166,255,0.1)] text-[#58a6ff] border border-[rgba(88,166,255,0.2)]';
    case 'AI':    return 'bg-[rgba(188,140,255,0.1)] text-[#bc8cff] border border-[rgba(188,140,255,0.2)]';
    case 'Social':return 'bg-[rgba(227,179,65,0.1)] text-[#e3b341] border border-[rgba(227,179,65,0.2)]';
    case 'Dev':   return 'bg-[rgba(248,81,73,0.1)] text-[#f85149] border border-[rgba(248,81,73,0.2)]';
    default:      return 'bg-surface2 text-text-muted border border-border';
  }
}

function formatGeo(geo: GeoInfo): string {
  return [geo.city, geo.regionName, geo.country, geo.isp || geo.org]
    .filter(Boolean).join(' ');
}

// 通过 Cloudflare cdn-cgi/trace 获取真实出口 IP（最准确，反映实际代理出口）
async function probeCFTrace(domain: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const resp = await fetch(`https://${domain}/cdn-cgi/trace`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await resp.text();
    return text.match(/^ip=(.+)$/m)?.[1]?.trim() ?? '';
  } catch {
    clearTimeout(timer);
    return '';
  }
}

async function fetchGeo(ip: string): Promise<GeoInfo | null> {
  try {
    const resp = await fetch(`/api/geo?ip=${encodeURIComponent(ip)}`, { cache: 'no-store' });
    return await resp.json();
  } catch {
    return null;
  }
}

async function probeSite(site: Site): Promise<SiteResult> {
  const ip = await probeCFTrace(site.domain);
  if (ip) {
    const geo = await fetchGeo(ip);
    return { ...site, ip, geo, done: true };
  }
  return { ...site, ip: '', geo: null, error: '无法获取', done: true };
}

export default function SplitCheckSection() {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [btnText, setBtnText] = createSignal('开始检测');
  const [results, setResults] = createSignal<SiteResult[]>([]);

  async function runCheck() {
    setTesting(true);
    setBtnText('检测中…');
    setBodyVisible(true);

    setResults(SITES.map(s => ({ ...s, ip: '', geo: null, done: false })));

    await Promise.all(SITES.map((site, i) =>
      probeSite(site).then(r => {
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
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
          网站分流检测
        </div>
        <button
          class="px-4 py-1.5 border border-border rounded-md bg-transparent text-text text-xs font-sans cursor-pointer transition-colors duration-200 shrink-0 hover:not-disabled:border-blue hover:not-disabled:text-blue hover:not-disabled:bg-[rgba(88,166,255,0.06)] disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={testing()}
          onClick={runCheck}
        >
          {btnText()}
        </button>
      </div>

      <Show when={bodyVisible()}>
        <div class="bg-bg border-t border-border-muted">
          <div class="px-[18px] pt-3 pb-2 text-[11px] text-text-muted">
            如果当前网络进行了 IP 分流，那么下面可以看到访问不同网站时所使用的 IP 及分流规则。如果下面出现"*未知*"状态，这并不代表您的网络有问题
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-[12px]">
              <thead>
                <tr class="border-b border-border-muted">
                  <th class="text-left px-[18px] py-2 text-[11px] font-medium text-text-muted">Website</th>
                  <th class="text-left px-4 py-2 text-[11px] font-medium text-text-muted w-[150px]">IP</th>
                  <th class="text-left px-4 py-2 text-[11px] font-medium text-text-muted">Geolocation</th>
                </tr>
              </thead>
              <tbody>
                <For each={results()}>
                  {(r) => (
                    <tr class="border-b border-border-muted last:border-b-0 hover:bg-surface transition-colors duration-100">
                      {/* 网站名 + 标签 */}
                      <td class="px-[18px] py-[9px]">
                        <div class="flex items-center gap-2 flex-wrap">
                          <img
                            src={`https://www.google.com/s2/favicons?sz=16&domain=${r.domain}`}
                            width="16" height="16"
                            class="rounded-sm shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                          <span class="font-medium text-text">{r.name}</span>
                          <div class="flex gap-1 flex-wrap">
                            <For each={r.tags}>
                              {(tag) => (
                                <span class={`text-[10px] px-[5px] py-[1px] rounded-[4px] font-medium leading-tight ${tagClass(tag)}`}>
                                  {tag}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                      </td>

                      {/* IP */}
                      <td class="px-4 py-[9px]">
                        {!r.done ? (
                          <div class="flex items-center gap-1.5 text-text-muted">
                            <div class="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse-dot shrink-0"></div>
                            <span>检测中</span>
                          </div>
                        ) : r.ip ? (
                          <span class="font-mono text-text">{r.ip}</span>
                        ) : (
                          <span class="text-text-muted">*未知*</span>
                        )}
                      </td>

                      {/* 地理位置 */}
                      <td class="px-4 py-[9px] text-text-muted">
                        {!r.done ? (
                          <span>—</span>
                        ) : r.geo ? (
                          <span class="flex items-center gap-1.5">
                            <span class="text-base leading-none">{countryFlag(r.geo.countryCode)}</span>
                            <span>{formatGeo(r.geo)}</span>
                          </span>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          <div class="px-[18px] py-2.5 text-[11px] text-text-muted flex items-center gap-1.5 border-t border-border-muted">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            通过各站点的 cdn-cgi/trace 接口获取真实出口 IP，结果反映当前网络的实际路由
          </div>
        </div>
      </Show>
    </div>
  );
}
