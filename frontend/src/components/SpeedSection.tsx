import { createSignal, Show } from 'solid-js';

const CF_DOWN = 'https://speed.cloudflare.com/__down';
const CF_UP   = 'https://speed.cloudflare.com/__up';

interface MetricState { value: string; unit: string; state: '' | 'active' | 'done'; }

function formatSpeed(mbps: number): { val: string; unit: string } {
  if (mbps >= 1000) return { val: (mbps / 1000).toFixed(2), unit: 'Gbps' };
  if (mbps >= 10)   return { val: mbps.toFixed(1), unit: 'Mbps' };
  if (mbps >= 1)    return { val: mbps.toFixed(2), unit: 'Mbps' };
  return { val: (mbps * 1000).toFixed(0), unit: 'Kbps' };
}

async function measureLatency(signal?: AbortSignal) {
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const start = performance.now();
    await fetch(CF_DOWN + '?bytes=0&_=' + Date.now(), { cache: 'no-store', mode: 'cors', signal });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const trimmed = times.slice(2, -2);
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  const jitter = Math.sqrt(trimmed.reduce((s, t) => s + (t - avg) ** 2, 0) / trimmed.length);
  return { latency: Math.round(avg * 10) / 10, jitter: Math.round(jitter * 10) / 10 };
}

async function measureDownload(onProgress: (mbps: number) => void, signal?: AbortSignal) {
  await fetch(CF_DOWN + '?bytes=2000000&_=' + Date.now(), { cache: 'no-store', signal });
  const resp = await fetch(CF_DOWN + '?bytes=25000000&_=' + Date.now(), { cache: 'no-store', mode: 'cors', signal });
  const reader = resp.body!.getReader();
  let totalBytes = 0;
  const startTime = performance.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    const elapsed = (performance.now() - startTime) / 1000;
    if (elapsed > 0.5) onProgress((totalBytes * 8) / (elapsed * 1000000));
  }
  return (totalBytes * 8) / ((performance.now() - startTime) / 1000 * 1000000);
}

async function measureUpload(_onProgress: (mbps: number) => void, signal?: AbortSignal) {
  const warmup = new Uint8Array(1000000).fill(0x61);
  await fetch(CF_UP, { method: 'POST', body: warmup, mode: 'cors', signal });
  const data = new Uint8Array(10000000).fill(0x61);
  const start = performance.now();
  await fetch(CF_UP, { method: 'POST', body: data, mode: 'cors', signal });
  return (data.length * 8) / ((performance.now() - start) / 1000 * 1000000);
}

export default function SpeedSection() {
  const mk = (): MetricState => ({ value: '—', unit: '', state: '' });
  const [ping, setPing] = createSignal<MetricState>(mk());
  const [jitter, setJitter] = createSignal<MetricState>(mk());
  const [down, setDown] = createSignal<MetricState>(mk());
  const [up, setUp] = createSignal<MetricState>(mk());
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [progressVisible, setProgressVisible] = createSignal(false);
  const [progressText, setProgressText] = createSignal('准备中…');
  const [progressWidth, setProgressWidth] = createSignal(0);
  const [errorText, setErrorText] = createSignal('');
  const [errorVisible, setErrorVisible] = createSignal(false);
  const [noteVisible, setNoteVisible] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [btnText, setBtnText] = createSignal('开始测速');
  let abortCtrl: AbortController | null = null;

  async function runSpeedTest() {
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    setTesting(true); setBtnText('测速中…'); setBodyVisible(true);
    setProgressVisible(true); setErrorVisible(false); setNoteVisible(false);
    setPing(mk()); setJitter(mk()); setDown(mk()); setUp(mk()); setProgressWidth(0);
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    try {
      setProgressText('测量延迟…');
      setPing({ value: '测量中', unit: '', state: 'active' });
      setJitter({ value: '测量中', unit: '', state: 'active' });
      const { latency, jitter: jv } = await measureLatency(signal);
      setProgressWidth(25);
      setPing({ value: latency.toFixed(1), unit: 'ms', state: 'done' });
      setJitter({ value: jv.toFixed(1), unit: 'ms', state: 'done' });

      setProgressText('测量下载速度…');
      setDown({ value: '测量中', unit: '', state: 'active' });
      const ds = await measureDownload((mbps) => {
        const f = formatSpeed(mbps);
        setDown({ value: f.val, unit: f.unit, state: 'active' });
        setProgressWidth(Math.min(65, 25 + (mbps > 0 ? 30 : 0)));
      }, signal);
      const df = formatSpeed(ds);
      setDown({ value: df.val, unit: df.unit, state: 'done' }); setProgressWidth(65);

      setProgressText('测量上传速度…');
      setUp({ value: '测量中', unit: '', state: 'active' });
      const us = await measureUpload((mbps) => {
        const f = formatSpeed(mbps);
        setUp({ value: f.val, unit: f.unit, state: 'active' });
      }, signal);
      const uf = formatSpeed(us);
      setUp({ value: uf.val, unit: uf.unit, state: 'done' }); setProgressWidth(100);
      setProgressText('✓ 测速完成');
      setTimeout(() => { setProgressVisible(false); }, 1500);
    } catch (e: any) {
      if (e.name === 'AbortError') { setProgressText('测速已取消'); }
      else { setErrorText('测速失败: ' + (e.message || '网络错误')); setErrorVisible(true); setProgressVisible(false); }
    } finally {
      setNoteVisible(true); setTesting(false); setBtnText('重新测速'); abortCtrl = null;
    }
  }

  function Metric(props: { icon: string; label: string; m: () => MetricState }) {
    return (
      <div class={`bg-surface2 border rounded-lg px-3 py-3.5 text-center transition-colors duration-300 ${props.m().state === 'active' ? 'border-blue' : props.m().state === 'done' ? 'border-[rgba(63,185,80,0.3)]' : 'border-border-muted'}`}>
        <div class="text-base mb-1.5">{props.icon}</div>
        <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-1">{props.label}</div>
        <div class={`font-mono text-[22px] font-semibold leading-tight ${props.m().state === 'active' ? 'text-blue animate-pulse-dot' : props.m().state === '' ? 'text-text-muted !text-sm' : 'text-text-bright'}`}>
          {props.m().state === 'done'
            ? <>{props.m().value}<span class="text-[11px] text-text-muted font-normal ml-0.5">{props.m().unit}</span></>
            : props.m().value}
        </div>
      </div>
    );
  }

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          网速测试
        </div>
        <button class="bg-transparent border border-border rounded-md text-blue text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(88,166,255,0.08)] hover:not-disabled:border-[rgba(88,166,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={testing()} onClick={runSpeedTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="px-[18px] pb-[18px]">
          <Show when={progressVisible()}>
            <div class="mb-3.5">
              <div class="text-[11px] text-text-muted mb-1.5 flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 border-2 border-border border-t-blue rounded-full animate-spin"></span><span>{progressText()}</span></div>
              <div class="h-[3px] bg-border-muted rounded-sm overflow-hidden"><div class="h-full bg-gradient-to-r from-blue to-purple rounded-sm transition-[width] duration-300" style={{ width: `${progressWidth()}%` }}></div></div>
            </div>
          </Show>
          <div class="grid grid-cols-4 gap-3 max-[600px]:grid-cols-2">
            <Metric icon="🏓" label="延迟" m={ping} />
            <Metric icon="📊" label="抖动" m={jitter} />
            <Metric icon="⬇️" label="下载" m={down} />
            <Metric icon="⬆️" label="上传" m={up} />
          </div>
          <Show when={errorVisible()}><div class="text-red text-xs py-2 text-center">{errorText()}</div></Show>
          <Show when={noteVisible()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted mt-3.5 leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>测速通过 Cloudflare 全球 CDN 边缘节点进行，结果反映您到最近 CF 节点的网络性能。实际体验可能因目标服务器不同而有差异。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
