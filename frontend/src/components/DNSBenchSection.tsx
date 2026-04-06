import { createSignal, Show, For, onCleanup } from 'solid-js';

interface BenchResult {
  name: string;
  ip: string;
  avg: number;
  min: number;
  max: number;
  loss: number;
  status: string;
}

function rttClass(ms: number): string {
  if (ms < 0) return 'timeout';
  if (ms < 50) return 'fast';
  if (ms < 150) return 'medium';
  return 'slow';
}

export default function DNSBenchSection() {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [statusHTML, setStatusHTML] = createSignal('');
  const [statusColor, setStatusColor] = createSignal('');
  const [results, setResults] = createSignal<BenchResult[]>([]);
  const [sorted, setSorted] = createSignal(false);
  const [noteVisible, setNoteVisible] = createSignal(false);
  const [btnText, setBtnText] = createSignal('开始测试');

  let abortCtrl: AbortController | null = null;

  onCleanup(() => {
    if (abortCtrl) abortCtrl.abort();
  });

  const maxRTT = () => {
    const vals = results().filter(r => r.avg > 0).map(r => r.avg);
    return Math.max(...vals, 1);
  };

  async function runDNSBench() {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }

    setTesting(true);
    setBtnText('测试中…');
    setBodyVisible(true);
    setResults([]);
    setSorted(false);
    setNoteVisible(false);
    setStatusColor('');
    setStatusHTML('<span class="inline-block align-middle w-3.5 h-3.5 border-2 border-border border-t-purple rounded-full animate-spin"></span> 正在测试各 DNS 解析器…');

    abortCtrl = new AbortController();
    let rank = 0;

    try {
      const resp = await fetch('/api/dns-bench', {
        signal: abortCtrl.signal
      });

      if (!resp.ok) {
        const err = await resp.text();
        let msg = '请求失败';
        try { msg = JSON.parse(err).error || msg; } catch (_) {}
        setStatusHTML(`<span style="color:var(--red)">${msg}</span>`);
        setTesting(false);
        setBtnText('开始测试');
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data: any;
          try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }

          if (data.done) {
            // Sort results by avg RTT (ok first, then timeout)
            setResults(prev => {
              const copy = [...prev];
              copy.sort((a, b) => {
                if (a.status === 'ok' && b.status !== 'ok') return -1;
                if (a.status !== 'ok' && b.status === 'ok') return 1;
                return a.avg - b.avg;
              });
              return copy;
            });
            setSorted(true);

            const res = results();
            const fastest = res.find(r => r.status === 'ok');
            if (fastest) {
              setStatusHTML(`✓ 测试完成 — 最快: <strong style="color:var(--green)">${fastest.name}</strong> (${fastest.avg.toFixed(1)} ms)`);
            } else {
              setStatusHTML('✓ 测试完成 — 所有解析器均超时');
            }
            setStatusColor('var(--green)');
            break;
          }

          // Streaming result — append immediately
          rank++;
          const item: BenchResult = {
            name: data.name,
            ip: data.ip,
            avg: data.avg,
            min: data.min,
            max: data.max,
            loss: data.loss,
            status: data.status || (data.avg > 0 ? 'ok' : 'timeout'),
          };
          setResults(prev => [...prev, item]);
          setStatusHTML(`<span class="inline-block align-middle w-3.5 h-3.5 border-2 border-border border-t-purple rounded-full animate-spin"></span> 已测试 ${rank} 个解析器…`);
        }
      }

    } catch (e: any) {
      if (e.name === 'AbortError') {
        setStatusHTML('测试已取消');
        setStatusColor('var(--text-muted)');
      } else {
        setStatusHTML(`<span style="color:var(--red)">测试失败: ${e.message}</span>`);
      }
    } finally {
      setNoteVisible(true);
      setTesting(false);
      setBtnText('重新测试');
      abortCtrl = null;
    }
  }

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-purple">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
          DNS 基准测试
        </div>
        <button class="bg-transparent border border-border rounded-md text-purple text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(188,140,255,0.08)] hover:not-disabled:border-[rgba(188,140,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={testing()} onClick={runDNSBench}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="px-[18px] pb-4">
          <div class="text-xs text-text-muted mb-2.5 flex items-center gap-1.5" style={{ color: statusColor() || undefined }} innerHTML={statusHTML()}></div>
          <Show when={results().length > 0}>
            <table class="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">#</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">解析器</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">平均延迟</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">最小</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">最大</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px]">丢包</th>
                  <th class="text-left text-text-muted font-medium px-2 py-1.5 border-b border-border text-[11px] uppercase tracking-[0.5px] w-[120px]">速度</th>
                </tr>
              </thead>
              <tbody>
                <For each={results()}>
                  {(item, index) => {
                    const cls = rttClass(item.avg);
                    const rttColor = cls === 'fast' ? 'text-green' : cls === 'medium' ? 'text-yellow' : cls === 'slow' ? 'text-red' : 'text-text-muted italic';
                    const barColor = cls === 'fast' ? 'bg-green' : cls === 'medium' ? 'bg-yellow' : 'bg-red';
                    const barWidth = () =>
                      sorted() && item.avg > 0 ? Math.max(5, (item.avg / maxRTT()) * 100) : 0;
                    return (
                      <tr>
                        <td class="px-2 py-2 border-b border-border-muted align-middle font-mono text-[11px] text-text-muted min-w-5">{index() + 1}</td>
                        <td class="px-2 py-2 border-b border-border-muted align-middle">
                          <span class="font-medium text-text-bright">{item.name}</span><br/>
                          <span class="font-mono text-text-muted text-[11px]">{item.ip}</span>
                        </td>
                        <td class={`px-2 py-2 border-b border-border-muted align-middle font-mono whitespace-nowrap ${rttColor}`}>{item.avg > 0 ? item.avg.toFixed(1) + ' ms' : '超时'}</td>
                        <td class={`px-2 py-2 border-b border-border-muted align-middle font-mono whitespace-nowrap ${item.min > 0 ? (rttClass(item.min) === 'fast' ? 'text-green' : rttClass(item.min) === 'medium' ? 'text-yellow' : 'text-red') : 'text-text-muted'}`}>{item.min > 0 ? item.min.toFixed(1) : '—'}</td>
                        <td class={`px-2 py-2 border-b border-border-muted align-middle font-mono whitespace-nowrap ${item.max > 0 ? (rttClass(item.max) === 'fast' ? 'text-green' : rttClass(item.max) === 'medium' ? 'text-yellow' : 'text-red') : 'text-text-muted'}`}>{item.max > 0 ? item.max.toFixed(1) : '—'}</td>
                        <td class={`px-2 py-2 border-b border-border-muted align-middle font-mono whitespace-nowrap ${item.loss > 0 ? 'text-red' : ''}`}>{item.loss}/3</td>
                        <td class="px-2 py-2 border-b border-border-muted align-middle w-[120px]">
                          <div class="h-1.5 bg-border-muted rounded-sm overflow-hidden">
                            <div class={`h-full rounded-sm transition-[width] duration-300 ${barColor}`} style={{ width: `${barWidth()}%` }}></div>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </Show>
          <Show when={noteVisible()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted mt-3 leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>DNS 查询从服务端发起，结果反映服务器到各 DNS 解析器的延迟。您本地到各解析器的延迟可能不同。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
