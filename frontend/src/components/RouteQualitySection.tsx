import { createSignal, Show, For } from 'solid-js';
import { geoToTags } from '../lib/api';
import type { GeoInfo } from '../lib/api';

interface BackboneNode {
  hop: number;
  ip: string;
  name: string;
  name_cn: string;
  asn: number;
}

interface TraceHop {
  hop: number;
  timeout: boolean;
  ip?: string;
  is_dest?: boolean;
  rtts?: number[];
  geo?: GeoInfo;
}

interface RouteQualityResult {
  target: string;
  route_type: string;
  route_desc: string;
  quality: string;
  score: number;
  backbones: BackboneNode[];
  hops: TraceHop[];
  error?: string;
}

// 预设探测目标
const PRESETS = [
  { label: '中国电信 DNS', value: '114.114.114.114' },
  { label: '阿里 DNS',     value: '223.5.5.5'       },
  { label: '腾讯 DNS',     value: '119.29.29.29'    },
  { label: '百度 DNS',     value: '180.76.76.76'    },
  { label: 'Cloudflare',  value: '1.1.1.1'          },
  { label: 'Google DNS',  value: '8.8.8.8'          },
];

// 骨干网标签颜色映射
const backboneColors: Record<string, string> = {
  CN2:    'bg-[rgba(63,185,80,0.1)] text-[#3fb950] border-[rgba(63,185,80,0.3)]',
  CT163:  'bg-[rgba(88,166,255,0.08)] text-[#58a6ff] border-[rgba(88,166,255,0.25)]',
  CTG:    'bg-[rgba(88,166,255,0.08)] text-[#58a6ff] border-[rgba(88,166,255,0.25)]',
  CU169:  'bg-[rgba(227,179,65,0.1)] text-[#e3b341] border-[rgba(227,179,65,0.3)]',
  CUG:    'bg-[rgba(227,179,65,0.1)] text-[#e3b341] border-[rgba(227,179,65,0.3)]',
  CMI:    'bg-[rgba(248,81,73,0.1)] text-[#f85149] border-[rgba(248,81,73,0.28)]',
  CMNET:  'bg-[rgba(248,81,73,0.08)] text-[#f85149] border-[rgba(248,81,73,0.22)]',
  CERNET: 'bg-[rgba(188,140,255,0.1)] text-[#bc8cff] border-[rgba(188,140,255,0.3)]',
};

// 质量标签样式
const qualityStyle: Record<string, { cls: string; label: string }> = {
  premium:  { cls: 'text-[#3fb950] border-[rgba(63,185,80,0.4)] bg-[rgba(63,185,80,0.08)]',  label: '高端线路' },
  good:     { cls: 'text-[#58a6ff] border-[rgba(88,166,255,0.35)] bg-[rgba(88,166,255,0.07)]', label: '优质线路' },
  standard: { cls: 'text-[#e3b341] border-[rgba(227,179,65,0.4)] bg-[rgba(227,179,65,0.07)]', label: '标准线路' },
  unknown:  { cls: 'text-text-muted border-border bg-surface2',                                 label: '未知线路' },
};

function BackboneTag(props: { name: string }) {
  const cls = backboneColors[props.name] ?? 'bg-surface2 text-text-muted border-border';
  return (
    <span class={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border font-medium ${cls}`}>
      {props.name}
    </span>
  );
}

interface RouteQualitySectionProps {
  clientIP: string | null;
}

export default function RouteQualitySection(props: RouteQualitySectionProps) {
  const defaultTarget = () => props.clientIP || '114.114.114.114';
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [target, setTarget] = createSignal('');
  const [result, setResult] = createSignal<RouteQualityResult | null>(null);
  const [errorMsg, setErrorMsg] = createSignal('');
  const [statusHTML, setStatusHTML] = createSignal('');

  async function runCheck(overrideTarget?: string) {
    const t = overrideTarget ?? (target().trim() || defaultTarget());
    if (!t) return;

    setTesting(true);
    setBodyVisible(true);
    setResult(null);
    setErrorMsg('');
    setStatusHTML(`<span class="inline-block align-middle w-3 h-3 border-2 border-border border-t-blue rounded-full animate-spin"></span> 正在检测路由至 ${t}…`);

    try {
      const resp = await fetch(`/api/route-quality?target=${encodeURIComponent(t)}`);
      const data: RouteQualityResult = await resp.json();
      if (data.error) {
        setErrorMsg(data.error);
        setStatusHTML('');
      } else {
        setResult(data);
        setStatusHTML('');
      }
    } catch (e: any) {
      setErrorMsg('请求失败: ' + e.message);
      setStatusHTML('');
    } finally {
      setTesting(false);
    }
  }

  function selectPreset(value: string) {
    setTarget(value);
    runCheck(value);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') runCheck();
  }

  const r = () => result();

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      {/* 标题栏 */}
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3 flex-wrap">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          {/* 线路图标 */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue">
            <path d="M3 12h4l3-9 6 18 3-9h5"/>
          </svg>
          线路质量检测
        </div>
        <div class="flex items-center gap-2">
          <input
            type="text"
            class="bg-surface2 border border-border rounded-md text-text font-mono text-xs px-2.5 py-[5px] w-[160px] outline-none transition-colors duration-150 focus:border-blue placeholder:text-text-muted"
            placeholder={defaultTarget() || 'IP 或域名'}
            spellcheck={false}
            value={target()}
            onInput={(e) => setTarget(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            class="bg-transparent border border-border rounded-md text-blue text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(88,166,255,0.08)] hover:not-disabled:border-[rgba(88,166,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={testing()}
            onClick={() => runCheck()}
          >
            {testing() ? '检测中…' : '检测'}
          </button>
        </div>
      </div>

      {/* 预设快捷目标 */}
      <div class="px-[18px] pb-3 flex flex-wrap gap-1.5">
        <For each={PRESETS}>
          {(p) => (
            <button
              class={`text-[11px] px-2 py-[3px] rounded-full border transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
                ${target() === p.value
                  ? 'border-[rgba(88,166,255,0.4)] text-blue bg-[rgba(88,166,255,0.08)]'
                  : 'border-border text-text-muted hover:border-blue hover:text-blue'}`}
              disabled={testing()}
              onClick={() => selectPreset(p.value)}
            >
              {p.label}
            </button>
          )}
        </For>
      </div>

      {/* 结果区 */}
      <Show when={bodyVisible()}>
        <div class="border-t border-border px-[18px] py-4 space-y-4">
          {/* 状态 */}
          <Show when={statusHTML()}>
            <div class="text-xs text-text-muted flex items-center gap-1.5" innerHTML={statusHTML()}></div>
          </Show>

          {/* 错误 */}
          <Show when={errorMsg()}>
            <div class="text-red text-xs">{errorMsg()}</div>
          </Show>

          {/* 检测结论 */}
          <Show when={r()}>
            {(res) => {
              const qs = qualityStyle[res().quality] ?? qualityStyle.unknown;
              // 去重骨干节点（按 name 去重，只保留首次出现）
              const uniqueBackbones = res().backbones.reduce<BackboneNode[]>((acc, b) => {
                if (!acc.find(x => x.name === b.name)) acc.push(b);
                return acc;
              }, []);

              return (
                <>
                  {/* 结论卡片 */}
                  <div class="flex items-start gap-3 p-3 rounded-lg bg-surface2 border border-border">
                    {/* 评分圆圈 */}
                    <div class="flex-shrink-0 w-12 h-12 rounded-full border-2 flex items-center justify-center"
                      style={{
                        'border-color': res().score >= 80 ? '#3fb950' : res().score >= 60 ? '#e3b341' : '#f85149',
                        'background': res().score >= 80 ? 'rgba(63,185,80,0.08)' : res().score >= 60 ? 'rgba(227,179,65,0.08)' : 'rgba(248,81,73,0.08)',
                      }}
                    >
                      <span class="text-sm font-bold font-mono"
                        style={{ color: res().score >= 80 ? '#3fb950' : res().score >= 60 ? '#e3b341' : '#f85149' }}
                      >
                        {res().score}
                      </span>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap mb-1">
                        <span class={`text-[11px] px-2 py-[2px] rounded-full border font-medium ${qs.cls}`}>{qs.label}</span>
                        <For each={uniqueBackbones}>
                          {(b) => <BackboneTag name={b.name} />}
                        </For>
                      </div>
                      <div class="text-[13px] text-text-bright font-medium leading-snug">{res().route_desc}</div>
                      <div class="text-[11px] text-text-muted mt-0.5 font-mono">目标: {res().target}</div>
                    </div>
                  </div>

                  {/* 骨干节点列表 */}
                  <Show when={res().backbones.length > 0}>
                    <div>
                      <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] font-medium mb-2">识别到的骨干网节点</div>
                      <table class="w-full border-collapse text-xs">
                        <thead>
                          <tr>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px] uppercase tracking-[0.5px]">#</th>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px] uppercase tracking-[0.5px]">IP</th>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px] uppercase tracking-[0.5px]">运营商</th>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px] uppercase tracking-[0.5px]">线路</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={res().backbones}>
                            {(b) => (
                              <tr>
                                <td class="px-2 py-[6px] border-b border-border-muted font-mono text-text-muted">{b.hop}</td>
                                <td class="px-2 py-[6px] border-b border-border-muted font-mono text-text-bright">{b.ip}</td>
                                <td class="px-2 py-[6px] border-b border-border-muted text-text">{b.name_cn}</td>
                                <td class="px-2 py-[6px] border-b border-border-muted"><BackboneTag name={b.name} /></td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>

                  {/* 完整路由跳表（折叠展示） */}
                  <Show when={res().hops && res().hops.length > 0}>
                    <details class="group">
                      <summary class="text-[11px] text-text-muted cursor-pointer select-none hover:text-text transition-colors list-none flex items-center gap-1">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="transition-transform group-open:rotate-90">
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                        查看完整路由路径（{res().hops.length} 跳）
                      </summary>
                      <table class="w-full border-collapse text-xs mt-2">
                        <thead>
                          <tr>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px]">#</th>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px]">IP</th>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px]">延迟</th>
                            <th class="text-left text-text-muted font-medium px-2 py-1 border-b border-border text-[11px]">归属地</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={res().hops}>
                            {(hop) => {
                              if (hop.timeout || !hop.ip) {
                                return (
                                  <tr class="text-text-muted">
                                    <td class="px-2 py-[5px] border-b border-border-muted font-mono">{hop.hop}</td>
                                    <td class="px-2 py-[5px] border-b border-border-muted font-mono">*</td>
                                    <td class="px-2 py-[5px] border-b border-border-muted font-mono">*</td>
                                    <td class="px-2 py-[5px] border-b border-border-muted"><span class="opacity-50">超时</span></td>
                                  </tr>
                                );
                              }
                              const rttStr = hop.rtts
                                ? hop.rtts.map(r => r < 0 ? '*' : r.toFixed(1) + 'ms').join(' / ')
                                : '';
                              const geoTags = hop.geo ? geoToTags(hop.geo) : [];
                              return (
                                <tr class={hop.is_dest ? 'text-green' : ''}>
                                  <td class="px-2 py-[5px] border-b border-border-muted font-mono text-text-muted">{hop.hop}</td>
                                  <td class="px-2 py-[5px] border-b border-border-muted font-mono text-text-bright">{hop.ip}{hop.is_dest ? ' ★' : ''}</td>
                                  <td class="px-2 py-[5px] border-b border-border-muted font-mono text-yellow whitespace-nowrap">{rttStr}</td>
                                  <td class="px-2 py-[5px] border-b border-border-muted">
                                    {geoTags.length > 0
                                      ? geoTags.map(t => (
                                          <span class={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] border whitespace-nowrap mr-0.5
                                            ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue'
                                            : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green'
                                            : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}`}>
                                            {t.text}
                                          </span>
                                        ))
                                      : <span class="text-text-muted">—</span>
                                    }
                                  </td>
                                </tr>
                              );
                            }}
                          </For>
                        </tbody>
                      </table>
                    </details>
                  </Show>
                </>
              );
            }}
          </Show>

          {/* 说明 */}
          <Show when={result() || errorMsg()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>从服务端发起 traceroute，通过识别路径中的骨干网 IP 和 ASN 判断线路类型。结果反映服务器到目标 IP 的上行路由，下行可能不同。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
