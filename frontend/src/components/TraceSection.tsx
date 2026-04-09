import { createSignal, Show, For, onCleanup, createMemo } from 'solid-js';
import { geoToTags } from '../lib/api';
import type { GeoInfo } from '../lib/api';

// 已知骨干网 ASN → 标签
const BACKBONE_ASN: Record<number, { name: string; cls: string }> = {
  4809:  { name: '电信 CN2',  cls: 'bg-[rgba(63,185,80,0.1)] text-[#3fb950] border-[rgba(63,185,80,0.3)]'    },
  4134:  { name: '电信 163',  cls: 'bg-[rgba(88,166,255,0.08)] text-[#58a6ff] border-[rgba(88,166,255,0.25)]' },
  23764: { name: '电信国际',   cls: 'bg-[rgba(88,166,255,0.08)] text-[#58a6ff] border-[rgba(88,166,255,0.25)]' },
  4837:  { name: '联通 169',  cls: 'bg-[rgba(227,179,65,0.1)] text-[#e3b341] border-[rgba(227,179,65,0.3)]'   },
  10099: { name: '联通国际',   cls: 'bg-[rgba(227,179,65,0.1)] text-[#e3b341] border-[rgba(227,179,65,0.3)]'   },
  58453: { name: '移动国际',   cls: 'bg-[rgba(248,81,73,0.1)] text-[#f85149] border-[rgba(248,81,73,0.28)]'    },
  9808:  { name: '移动骨干',   cls: 'bg-[rgba(248,81,73,0.08)] text-[#f85149] border-[rgba(248,81,73,0.22)]'   },
  56040: { name: '移动骨干',   cls: 'bg-[rgba(248,81,73,0.08)] text-[#f85149] border-[rgba(248,81,73,0.22)]'   },
  4538:  { name: '教育网',     cls: 'bg-[rgba(188,140,255,0.1)] text-[#bc8cff] border-[rgba(188,140,255,0.3)]'  },
};

const BACKBONE_PREFIX: Array<{ prefix: string; asn: number }> = [
  // 电信
  { prefix: '59.43.',   asn: 4809 },
  { prefix: '202.97.',  asn: 4134 },
  // 联通
  { prefix: '219.158.', asn: 4837 },
  { prefix: '210.51.',  asn: 4837 },
  { prefix: '202.96.',  asn: 4837 },
  { prefix: '61.135.',  asn: 4837 },
  { prefix: '60.208.',  asn: 4837 },
  // 移动
  { prefix: '211.136.', asn: 9808 },
  { prefix: '221.183.', asn: 9808 },
  { prefix: '120.196.', asn: 9808 },
  { prefix: '117.131.', asn: 9808 },
  { prefix: '223.104.', asn: 56040 },
];

function getBackbone(ip?: string, geo?: GeoInfo) {
  if (geo?.asn && BACKBONE_ASN[geo.asn]) return BACKBONE_ASN[geo.asn];
  if (ip) {
    for (const p of BACKBONE_PREFIX) {
      if (ip.startsWith(p.prefix)) return BACKBONE_ASN[p.asn];
    }
  }
  return null;
}

// 根据骨干网组合判断线路类型和质量评分
function analyzeRoute(names: string[]): { label: string; desc: string; score: number; scoreCls: string } | null {
  const has = (n: string) => names.includes(n);
  if (has('电信 CN2') && !has('电信 163')) return { label: '高端线路', desc: '电信 CN2 GIA，全程走 CN2 骨干',    score: 95, scoreCls: '#3fb950' };
  if (has('电信 CN2') && has('电信 163'))  return { label: '优质线路', desc: '电信 CN2 GT，混合经过 163 骨干',  score: 80, scoreCls: '#58a6ff' };
  if (has('电信国际'))                      return { label: '优质线路', desc: '走电信国际骨干',               score: 75, scoreCls: '#58a6ff' };
  if (has('电信 163'))                      return { label: '标准线路', desc: '走电信 163 普通骨干',          score: 60, scoreCls: '#e3b341' };
  if (has('联通国际'))                      return { label: '优质线路', desc: '走联通国际骨干',               score: 80, scoreCls: '#58a6ff' };
  if (has('联通 169'))                      return { label: '标准线路', desc: '走联通 169 普通骨干',          score: 60, scoreCls: '#e3b341' };
  if (has('移动国际'))                      return { label: '优质线路', desc: '走移动国际骨干',               score: 75, scoreCls: '#58a6ff' };
  if (has('移动骨干'))                      return { label: '标准线路', desc: '走移动普通骨干',               score: 55, scoreCls: '#e3b341' };
  if (has('教育网'))                        return { label: '标准线路', desc: '走中国教育网骨干',             score: 65, scoreCls: '#e3b341' };
  return null;
}

// 预设探测目标
const PRESETS = [
  { label: '追踪我',      value: '__client__'    },
  { label: '电信',        value: '114.114.114.114' },
  { label: '联通',        value: '218.104.111.114' },
  { label: '移动',        value: '120.196.165.24'  },
  { label: '阿里 DNS',    value: '223.5.5.5'       },
  { label: 'Cloudflare', value: '1.1.1.1'          },
];

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
  const [done, setDone] = createSignal(false);

  // 骨干网汇总（去重，按首次出现顺序）
  const backboneSummary = createMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ name: string; cls: string }> = [];
    for (const hop of hops()) {
      const bb = getBackbone(hop.ip, hop.geo);
      if (bb && !seen.has(bb.name)) {
        seen.add(bb.name);
        result.push(bb);
      }
    }
    return result;
  });

  // 线路分析结论（追踪完成后才显示）
  const routeAnalysis = createMemo(() => {
    if (!done() || backboneSummary().length === 0) return null;
    return analyzeRoute(backboneSummary().map(b => b.name));
  });

  let abortCtrl: AbortController | null = null;
  let tableEndRef: HTMLTableRowElement | undefined;

  onCleanup(() => { if (abortCtrl) abortCtrl.abort(); });

  async function runTrace(overrideTarget?: string) {
    const t = overrideTarget || target().trim();
    if (!t) return;

    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }

    setTracing(true);
    setBodyVisible(true);
    setHops([]);
    setErrorHTML('');
    setDone(false);
    setStatusColor('');
    setStatusHTML(`<span class="inline-block align-middle w-3 h-3 border-2 border-border border-t-green rounded-full animate-spin"></span> 正在追踪 ${t}…`);

    abortCtrl = new AbortController();

    try {
      const resp = await fetch('/api/trace?target=' + encodeURIComponent(t), { signal: abortCtrl.signal });

      if (!resp.ok) {
        const err = await resp.text();
        let msg = '请求失败';
        try { msg = JSON.parse(err).error || msg; } catch (_) {}
        setStatusHTML('');
        setErrorHTML(msg);
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hopCount = 0;
      let streamDone = false;

      while (!streamDone) {
        const { value, done: rd } = await reader.read();
        if (rd) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data: any;
          try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }

          if (data.done) {
            streamDone = true;
            if (data.error) {
              setStatusHTML('');
              setErrorHTML(data.error);
            } else {
              const totalHops = data.hops ? data.hops.length : hopCount;
              const reached = data.hops && data.hops.some((h: any) => h.is_dest);
              setStatusHTML(reached
                ? `✓ 追踪完成，共 ${totalHops} 跳，已到达目标 ${data.resolved_ip}`
                : `✓ 追踪完成，共 ${totalHops} 跳（未到达目标）`);
              setStatusColor(reached ? 'var(--green)' : 'var(--yellow)');
              setDone(true);
            }
            break;
          }

          hopCount++;
          setHops(prev => [...prev, {
            hop: data.hop,
            timeout: !!data.timeout,
            ip: data.ip,
            is_dest: data.is_dest,
            rtts: data.rtts,
            geo: data.geo,
          }]);
          setStatusHTML(`<span class="inline-block align-middle w-3 h-3 border-2 border-border border-t-green rounded-full animate-spin"></span> 正在追踪 ${t}… (${hopCount} 跳)`);
          tableEndRef?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      setTracing(false);
      abortCtrl = null;
    }
  }

  function selectPreset(value: string) {
    if (value === '__client__') {
      const ip = props.clientIP;
      if (!ip || ip === '未知' || ip === '请求失败') {
        alert('客户端 IP 尚未检测到，请等待检测完成');
        return;
      }
      setTarget(ip);
      runTrace(ip);
    } else {
      setTarget(value);
      runTrace(value);
    }
  }

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      {/* 标题栏 */}
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-green">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          路由追踪 &amp; 线路检测
        </div>
        <div class="flex items-center gap-2">
          <input
            type="text"
            class="bg-surface2 border border-border rounded-md text-text font-mono text-xs px-2.5 py-[5px] w-[170px] outline-none transition-colors duration-150 focus:border-green placeholder:text-text-muted"
            placeholder="IP 或域名"
            spellcheck={false}
            value={target()}
            onInput={(e) => setTarget(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && runTrace()}
          />
          <button
            class="bg-transparent border border-border rounded-md text-green text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(63,185,80,0.08)] hover:not-disabled:border-[rgba(63,185,80,0.4)] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={tracing()}
            onClick={() => runTrace()}
          >
            {tracing() ? '追踪中…' : '追踪'}
          </button>
        </div>
      </div>

      {/* 预设快捷目标 */}
      <div class="px-[18px] pb-3 flex flex-wrap gap-1.5">
        <For each={PRESETS}>
          {(p) => (
            <button
              class={`text-[11px] px-2 py-[3px] rounded-full border transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
                ${(p.value !== '__client__' && target() === p.value)
                  ? 'border-[rgba(63,185,80,0.4)] text-green bg-[rgba(63,185,80,0.08)]'
                  : 'border-border text-text-muted hover:border-green hover:text-green'}`}
              disabled={tracing()}
              onClick={() => selectPreset(p.value)}
            >
              {p.value === '__client__'
                ? <><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:-1px;margin-right:3px"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>{p.label}</>
                : p.label
              }
            </button>
          )}
        </For>
      </div>

      {/* 结果区 */}
      <Show when={bodyVisible()}>
        <div class="border-t border-border px-[18px] py-4 space-y-3">

          {/* 状态行 + 骨干网标签 */}
          <div class="text-xs text-text-muted flex items-center gap-2 flex-wrap">
            <span style={{ color: statusColor() || undefined }} innerHTML={statusHTML()}></span>
            <Show when={backboneSummary().length > 0}>
              <span class="flex items-center gap-1">
                <For each={backboneSummary()}>
                  {(bb) => <span class={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border font-medium ${bb.cls}`}>{bb.name}</span>}
                </For>
              </span>
            </Show>
          </div>

          {/* 线路分析卡片（追踪完成后） */}
          <Show when={routeAnalysis()}>
            {(ra) => (
              <div class="flex items-center gap-3 p-3 rounded-lg bg-surface2 border border-border">
                <div
                  class="flex-shrink-0 w-10 h-10 rounded-full border-2 flex items-center justify-center"
                  style={{ 'border-color': ra().scoreCls, background: ra().scoreCls + '18' }}
                >
                  <span class="text-xs font-bold font-mono" style={{ color: ra().scoreCls }}>{ra().score}</span>
                </div>
                <div>
                  <div class="flex items-center gap-2 mb-0.5">
                    <span
                      class="text-[11px] px-2 py-[2px] rounded-full border font-medium"
                      style={{ color: ra().scoreCls, 'border-color': ra().scoreCls + '66', background: ra().scoreCls + '14' }}
                    >{ra().label}</span>
                    <For each={backboneSummary()}>
                      {(bb) => <span class={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border font-medium ${bb.cls}`}>{bb.name}</span>}
                    </For>
                  </div>
                  <div class="text-[13px] text-text-bright font-medium">{ra().desc}</div>
                </div>
              </div>
            )}
          </Show>

          {/* 错误 */}
          <Show when={errorHTML()}>
            <div class="text-red text-xs">{errorHTML()}</div>
          </Show>

          {/* 跳表 */}
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
                          <td class="px-2 py-[7px] border-b border-border-muted align-top">
                            <span class="inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border whitespace-nowrap opacity-50 border-border text-text-muted">超时</span>
                          </td>
                        </tr>
                      );
                    }
                    const rttStr = hop.rtts
                      ? hop.rtts.map(r => r < 0 ? '*' : r.toFixed(1) + 'ms').join(' / ')
                      : '';
                    const geoTags = hop.geo ? geoToTags(hop.geo) : [];
                    const bb = getBackbone(hop.ip, hop.geo);
                    return (
                      <tr class={hop.is_dest ? 'text-green' : ''}>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono text-text-muted min-w-7">{hop.hop}</td>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono text-text-bright">{hop.ip}{hop.is_dest ? ' ★' : ''}</td>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top font-mono text-yellow whitespace-nowrap">{rttStr}</td>
                        <td class="px-2 py-[7px] border-b border-border-muted align-top">
                          <div class="flex items-center gap-1 flex-wrap">
                            {geoTags.length > 0
                              ? geoTags.map(t => <span class={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border whitespace-nowrap ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue' : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green' : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}`}>{t.text}</span>)
                              : <span class="text-text-muted">—</span>
                            }
                            {bb && <span class={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border font-medium whitespace-nowrap ${bb.cls}`}>{bb.name}</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
                <tr ref={tableEndRef} style="height:0;padding:0;border:none"><td style="height:0;padding:0;border:none"></td></tr>
              </tbody>
            </table>
          </Show>

          {/* 说明 */}
          <Show when={done() || errorHTML()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>路由追踪从服务端发起，显示服务器到目标的路径。线路检测根据路径中出现的骨干网 IP 自动分析。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
