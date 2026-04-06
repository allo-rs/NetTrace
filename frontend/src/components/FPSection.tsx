import { createSignal, Show, For } from 'solid-js';
import { simpleHash } from '../lib/api';

// ── Client-side fingerprint helpers ──────────────────────────────

function getCanvasFingerprint(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d')!;
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('NetTrace fp', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('NetTrace fp', 4, 17);
    return simpleHash(canvas.toDataURL());
  } catch { return 'N/A'; }
}

function getWebGLInfo(): { vendor: string; renderer: string } {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: 'N/A', renderer: 'N/A' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    };
  } catch { return { vendor: 'N/A', renderer: 'N/A' }; }
}

function parseBrowser(): string {
  const ua = navigator.userAgent;
  let browser = '未知', version = '';
  if (ua.includes('Firefox/')) { browser = 'Firefox'; version = ua.match(/Firefox\/([\d.]+)/)?.[1] || ''; }
  else if (ua.includes('Edg/')) { browser = 'Edge'; version = ua.match(/Edg\/([\d.]+)/)?.[1] || ''; }
  else if (ua.includes('Chrome/') && !ua.includes('Edg/')) { browser = 'Chrome'; version = ua.match(/Chrome\/([\d.]+)/)?.[1] || ''; }
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) { browser = 'Safari'; version = ua.match(/Version\/([\d.]+)/)?.[1] || ''; }
  return browser + (version ? ' ' + version : '');
}

function parseOS(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Windows NT 10.0')) return 'Windows 10/11';
  if (ua.includes('Windows NT')) return 'Windows';
  if (ua.includes('Mac OS X')) { const v = ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.'); return 'macOS' + (v ? ' ' + v : ''); }
  if (ua.includes('Linux') && ua.includes('Android')) return 'Android';
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return '未知';
}

// ── Component ────────────────────────────────────────────────────

export default function FPSection() {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [btnText, setBtnText] = createSignal('开始检测');
  const [browserRows, setBrowserRows] = createSignal<[string, string][]>([]);
  const [headerRows, setHeaderRows] = createSignal<[string, string][]>([]);
  const [headerLoading, setHeaderLoading] = createSignal(false);
  const [headerError, setHeaderError] = createSignal('');
  const [noteVisible, setNoteVisible] = createSignal(false);

  async function runFingerprintTest() {
    setTesting(true);
    setBtnText('检测中…');
    setBodyVisible(true);
    setBrowserRows([]);
    setHeaderRows([]);
    setHeaderLoading(true);
    setHeaderError('');
    setNoteVisible(false);

    // 1. Browser fingerprint (client-side)
    const canvasHash = getCanvasFingerprint();
    const webgl = getWebGLInfo();
    const browser = parseBrowser();
    const os = parseOS();
    const langs = navigator.languages ? navigator.languages.join(', ') : navigator.language;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const screenStr = `${window.screen.width}×${window.screen.height} (${window.devicePixelRatio}x)`;
    const cores = String(navigator.hardwareConcurrency || 'N/A');
    const mem = (navigator as any).deviceMemory ? (navigator as any).deviceMemory + ' GB' : 'N/A';
    const touch = navigator.maxTouchPoints > 0 ? `是 (${navigator.maxTouchPoints} 点)` : '否';
    const cookieEnabled = navigator.cookieEnabled ? '是' : '否';
    const dnt = navigator.doNotTrack === '1' ? '是' : '否';
    const platform = navigator.platform || 'N/A';

    // Compose unique fingerprint hash
    const fpRaw = [canvasHash, webgl.renderer, langs, tz, screenStr, cores, platform].join('|');
    const fpHash = simpleHash(fpRaw);

    setBrowserRows([
      ['浏览器', browser],
      ['操作系统', os],
      ['平台', platform],
      ['语言', langs],
      ['时区', tz],
      ['屏幕分辨率', screenStr],
      ['CPU 核心数', cores],
      ['设备内存', mem],
      ['触控支持', touch],
      ['Cookie', cookieEnabled],
      ['Do Not Track', dnt],
      ['Canvas 哈希', canvasHash],
      ['WebGL 厂商', webgl.vendor],
      ['WebGL 渲染器', webgl.renderer],
      ['综合指纹哈希', fpHash],
    ]);

    // 2. Server-side HTTP headers
    try {
      const resp = await fetch('/api/headers', { cache: 'no-store' });
      const data = await resp.json();

      const rows: [string, string][] = [];
      rows.push(['请求方法', data.method]);
      rows.push(['协议版本', data.protocol]);
      rows.push(['Host', data.host]);
      rows.push(['客户端 IP', data.client_ip]);
      rows.push(['RemoteAddr', data.remote_addr]);
      rows.push(['TLS 加密', data.tls ? '是' : '否']);

      if (data.headers && data.headers.length > 0) {
        for (const h of data.headers) {
          rows.push([h.name, h.value]);
        }
      }

      setHeaderRows(rows);
    } catch (e: any) {
      setHeaderError('请求失败: ' + e.message);
    } finally {
      setHeaderLoading(false);
    }

    setNoteVisible(true);
    setTesting(false);
    setBtnText('重新检测');
  }

  // Helper: some values need special rendering (hash badges)
  function isHashField(key: string): boolean {
    return key === 'Canvas 哈希' || key === 'WebGL 渲染器' || key === '综合指纹哈希';
  }

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-green">
            <path d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 0 0 8 11a4 4 0 1 1 8 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0 0 15.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 0 0 8.08 3.488M3 3l18 18"/>
          </svg>
          HTTP / 浏览器指纹
        </div>
        <button class="bg-transparent border border-border rounded-md text-green text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(63,185,80,0.08)] hover:not-disabled:border-[rgba(63,185,80,0.4)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={testing()} onClick={runFingerprintTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="px-[18px] pb-4">
          <div class="mb-3.5">
            <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-2 font-medium">🌐 浏览器指纹</div>
            <Show when={browserRows().length > 0} fallback={
              <table class="w-full border-collapse text-xs"><tbody><tr><td colSpan={2} style="color:var(--text-muted)">采集中…</td></tr></tbody></table>
            }>
              <table class="w-full border-collapse text-xs">
                <tbody>
                  <For each={browserRows()}>
                    {(row) => (
                      <tr>
                        <td class="py-[5px] px-2 border-b border-border-muted align-top text-text-muted whitespace-nowrap w-[140px] font-medium last:border-b-0">{row[0]}</td>
                        <td class="py-[5px] px-2 border-b border-border-muted align-top font-mono text-text-bright break-all last:border-b-0">
                          {isHashField(row[0])
                            ? <span class="font-mono text-[11px] text-purple bg-surface2 px-2 py-[2px] rounded inline-block">{row[1]}</span>
                            : row[1]
                          }
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
          <div class="mb-3.5">
            <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-2 font-medium">📡 服务端收到的 HTTP 请求头</div>
            <Show when={headerError()}>
              <table class="w-full border-collapse text-xs"><tbody><tr><td colSpan={2} style="color:var(--red)">{headerError()}</td></tr></tbody></table>
            </Show>
            <Show when={headerLoading() && !headerError()}>
              <table class="w-full border-collapse text-xs"><tbody><tr><td colSpan={2} style="color:var(--text-muted)">请求中…</td></tr></tbody></table>
            </Show>
            <Show when={headerRows().length > 0 && !headerError()}>
              <table class="w-full border-collapse text-xs">
                <tbody>
                  <For each={headerRows()}>
                    {(row) => (
                      <tr>
                        <td class="py-[5px] px-2 border-b border-border-muted align-top text-text-muted whitespace-nowrap w-[140px] font-medium last:border-b-0">{row[0]}</td>
                        <td class="py-[5px] px-2 border-b border-border-muted align-top font-mono text-text-bright break-all last:border-b-0">{row[1]}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
          <Show when={noteVisible()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted mt-3 leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>浏览器指纹基于本地 JavaScript 采集，HTTP 头由服务端返回。Canvas/WebGL 哈希可用于跨站追踪识别。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
