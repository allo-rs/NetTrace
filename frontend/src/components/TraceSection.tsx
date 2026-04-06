import { createSignal, Show, For, onCleanup } from 'solid-js';
import { geoToTags } from '../lib/api';
import type { GeoInfo } from '../lib/api';

interface TraceHop {
  hop: number;
  timeout: boolean;
  ip?: string;
  is_dest?: boolean;
  rtts?: number[];
  geo?: GeoInfo;
}

interface TraceSectionProps {
  clientIP: string | null;
}

export default function TraceSection(props: TraceSectionProps) {
  const [tracing, setTracing] = createSignal(false);
  const [target, setTarget] = createSignal('');
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [statusHTML, setStatusHTML] = createSignal('');
  const [statusColor, setStatusColor] = createSignal('');
  const [hops, setHops] = createSignal<TraceHop[]>([]);
  const [errorHTML, setErrorHTML] = createSignal('');
  const [noteVisible, setNoteVisible] = createSignal(false);
  const [btnText, setBtnText] = createSignal('追踪');

  let abortCtrl: AbortController | null = null;
  let tableEndRef: HTMLTableRowElement | undefined;

  onCleanup(() => {
    if (abortCtrl) abortCtrl.abort();
  });

  function traceToClient() {
    const ip = props.clientIP;
    if (!ip || ip === '未知' || ip === '请求失败') {
      alert('客户端 IP 尚未检测到，请等待检测完成');
      return;
    }
    setTarget(ip);
    runTrace(ip);
  }

  async function runTrace(overrideTarget?: string) {
    const t = overrideTarget || target().trim();
    if (!t) return;

    // Abort previous
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }

    setTracing(true);
    setBtnText('追踪中…');
    setBodyVisible(true);
    setHops([]);
    setErrorHTML('');
    setNoteVisible(false);
    setStatusColor('');
    setStatusHTML(`<span class="inline-block align-middle w-3 h-3 border-2 border-border border-t-green rounded-full animate-spin"></span> 正在追踪 ${t}…`);

    abortCtrl = new AbortController();

    try {
      const resp = await fetch('/api/trace?target=' + encodeURIComponent(t), {
        signal: abortCtrl.signal
      });

      if (!resp.ok) {
        const err = await resp.text();
        let msg = '请求失败';
        try { msg = JSON.parse(err).error || msg; } catch (_) {}
        setStatusHTML('');
        setErrorHTML(msg);
        setTracing(false);
        setBtnText('追踪');
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hopCount = 0;
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);
          let data: any;
          try { data = JSON.parse(jsonStr); } catch (_) { continue; }

          if (data.done) {
            done = true;
            if (data.error) {
              setStatusHTML('');
              setErrorHTML(data.error);
            } else {
              const totalHops = data.hops ? data.hops.length : hopCount;
              const reached = data.hops && data.hops.some((h: any) => h.is_dest);
              const statusMsg = reached
                ? `✓ 追踪完成，共 ${totalHops} 跳，已到达目标 ${data.resolved_ip}`
                : `✓ 追踪完成，共 ${totalHops} 跳（未到达目标）`;
              setStatusHTML(statusMsg);
              setStatusColor(reached ? 'var(--green)' : 'var(--yellow)');
            }
            break;
          }

          // It's a hop event
          hopCount++;
          const hop: TraceHop = {
            hop: data.hop,
            timeout: !!data.timeout,
            ip: data.ip,
            is_dest: data.is_dest,
            rtts: data.rtts,
            geo: data.geo,
          };
          setHops(prev => [...prev, hop]);

          // Update status
          setStatusHTML(`<span class="inline-block align-middle w-3 h-3 border-2 border-border border-t-green rounded-full animate-spin"></span> 正在追踪 ${t}… (${hopCount} 跳)`);

          // Auto-scroll
          if (tableEndRef) {
            tableEndRef.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      }

    } catch (e: any) {
      if (e.name === 'AbortError') {
        setStatusHTML('追踪已取消');
        setStatusColor('var(--text-muted)');
      } else {
        setStatusHTML('');
        setErrorHTML('连接失败: ' + e.message);
      }
    } finally {
      setNoteVisible(true);
      setTracing(false);
      setBtnText('追踪');
      abortCtrl = null;
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') runTrace();
  }

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-green">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          路由追踪
        </div>
        <div class="flex items-center gap-2">
          <input
            type="text"
            class="bg-surface2 border border-border rounded-md text-text font-mono text-xs px-2.5 py-[5px] w-[180px] outline-none transition-colors duration-150 focus:border-blue placeholder:text-text-muted"
            placeholder="IP 或域名"
            spellcheck={false}
            value={target()}
            onInput={(e) => setTarget(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <button class="bg-transparent border border-border rounded-md text-green text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(63,185,80,0.08)] hover:not-disabled:border-[rgba(63,185,80,0.4)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={tracing()} onClick={() => runTrace()}>{btnText()}</button>
          <button class="bg-transparent border border-border rounded-md text-green text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(63,185,80,0.08)] hover:not-disabled:border-[rgba(63,185,80,0.4)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={tracing()} onClick={traceToClient} title="追踪到您的客户端 IP">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            {' '}追踪我
          </button>
        </div>
      </div>
      <Show when={bodyVisible()}>
        <div class="px-[18px] pb-4">
          <div class="text-xs text-text-muted mb-2.5 flex items-center gap-1.5" style={{ color: statusColor() || undefined }} innerHTML={statusHTML()}></div>
          <Show when={errorHTML()}>
            <div class="text-red text-xs py-2">{errorHTML()}</div>
          </Show>
          <Show when={hops().length > 0}>
            <table class="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">#</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">IP 地址</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">延迟</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">归属地</th>
                </tr>
              </thead>
              <tbody>
                <For each={hops()}>
                  {(hop) => {
                    if (hop.timeout) {
                      return (
                        <tr class="text-text-muted italic">
                          <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono min-w-7">{hop.hop}</td>
                          <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono">*</td>
                          <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono whitespace-nowrap">*</td>
                          <td class="px-2 py-[7px] border-b border-border-muted align-top"><span class="inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border whitespace-nowrap opacity-50 border-border text-text-muted">超时</span></td>
                        </tr>
                      );
                    }
                    const rttStr = hop.rtts
                      ? hop.rtts.map(r => r < 0 ? '*' : r.toFixed(1) + 'ms').join(' / ')
                      : '';
                    const geoTags = hop.geo ? geoToTags(hop.geo) : [];
                    return (
                      <tr class={hop.is_dest ? 'text-green' : ''}>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono text-text-muted min-w-7">{hop.hop}</td>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono text-text-bright">{hop.ip}{hop.is_dest ? ' ★' : ''}</td>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono text-yellow whitespace-nowrap">{rttStr}</td>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top">
                          {geoTags.length > 0
                            ? geoTags.map(t => <span class={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border whitespace-nowrap ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue' : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green' : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}`}>{t.text}</span>)
                            : <span class="text-text-muted">—</span>
                          }
                        </td>
                      </tr>
                    );
                  }}
                </For>
                <tr ref={tableEndRef} style="height:0;padding:0;border:none"><td style="height:0;padding:0;border:none"></td></tr>
              </tbody>
            </table>
          </Show>
          <Show when={noteVisible()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted mt-2.5 leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>路由追踪从服务端发起，显示的是服务器到目标 IP 的网络路径。部分云服务器可能屏蔽 ICMP，导致中间跳显示超时。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
