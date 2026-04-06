import { createSignal, Show } from 'solid-js';
import { randToken, getDomain, sleep, geoToTags, LEAK_PROBE_COUNT, LEAK_TIMEOUT_MS } from '../lib/api';

interface LeakSectionProps {
  onClientIP?: (ip: string) => void;
}

export default function LeakSection(props: LeakSectionProps) {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [progressVisible, setProgressVisible] = createSignal(false);
  const [progressText, setProgressText] = createSignal('');
  const [progressWidth, setProgressWidth] = createSignal(0);
  const [resultHTML, setResultHTML] = createSignal('');
  const [btnText, setBtnText] = createSignal('开始检测');

  async function runLeakTest() {
    if (testing()) return;

    setTesting(true);
    setBtnText('检测中…');
    setBodyVisible(true);
    setProgressVisible(true);
    setResultHTML('');
    setProgressWidth(0);
    setProgressText(`探测中 0/${LEAK_PROBE_COUNT}`);

    // Generate N tokens and trigger DNS probes
    const domain = getDomain();
    const tokens = Array.from({ length: LEAK_PROBE_COUNT }, () => randToken());
    tokens.forEach(t => {
      const img = new Image();
      img.src = `http://${t}.${domain}/probe.png?t=${Date.now()}`;
    });

    // Poll until all captured or timeout
    const deadline = Date.now() + LEAK_TIMEOUT_MS;
    let data: any = null;

    await sleep(600);

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`/api/leak?tokens=${tokens.join(',')}`);
        data = await res.json();

        const pct = (data.captured_count / LEAK_PROBE_COUNT) * 100;
        setProgressWidth(pct);
        setProgressText(`探测中 ${data.captured_count}/${LEAK_PROBE_COUNT}`);

        if (data.captured_count >= LEAK_PROBE_COUNT) break;
      } catch (e) {
        console.warn('[leak poll] error:', e);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(800, remaining));
    }

    // Clean up server-side tokens (fire-and-forget)
    fetch(`/api/leak?tokens=${tokens.join(',')}`, { method: 'DELETE' }).catch(() => {});

    // Render result
    renderLeakResult(data);
    setProgressVisible(false);
    setTesting(false);
    setBtnText('重新检测');
  }

  function renderLeakResult(data: any) {
    if (!data) {
      setResultHTML('<div class="text-xs text-text-muted italic py-2 text-center">请求失败，请稍后重试</div>');
      return;
    }

    // Notify parent of detected client IP
    if (data.client_ip && props.onClientIP) {
      props.onClientIP(data.client_ip);
    }

    const captured = data.captured_count;
    const total = data.total_count;
    const unique: string[] = data.unique_resolvers || [];

    let badgeCls: string, badgeIcon: string, badgeText: string;
    if (captured === 0) {
      badgeCls = 'bg-[rgba(227,179,65,0.08)] border border-[rgba(227,179,65,0.3)] text-yellow'; badgeIcon = '⚠'; badgeText = '未能捕获任何探针（可能启用了 DoH）';
    } else if (data.leaked) {
      badgeCls = 'bg-[rgba(248,81,73,0.08)] border border-[rgba(248,81,73,0.3)] text-red'; badgeIcon = '✕'; badgeText = `检测到 ${unique.length} 个不同 DNS 解析器，存在泄漏风险`;
    } else if (captured < total) {
      badgeCls = 'bg-[rgba(227,179,65,0.08)] border border-[rgba(227,179,65,0.3)] text-yellow'; badgeIcon = '△'; badgeText = `仅捕获 ${captured}/${total} 个探针，结果不完整`;
    } else {
      badgeCls = 'bg-[rgba(63,185,80,0.08)] border border-[rgba(63,185,80,0.3)] text-green'; badgeIcon = '✓'; badgeText = '所有探针均通过同一 DNS 解析器，未发现泄漏';
    }

    let resolversHTML = '';
    if (unique.length > 0) {
      resolversHTML = '<div class="flex flex-col gap-2">' +
        unique.map((ip: string, i: number) => {
          const result = data.results.find((r: any) => r.resolver_ip === ip);
          const geo = result && result.resolver_geo;
          const tags = geo ? geoToTags(geo).map(t =>
            `<span class="inline-flex items-center px-[9px] py-[3px] rounded-full text-[11px] border whitespace-nowrap ${t.cls === 'loc' ? 'bg-[rgba(88,166,255,0.07)] border-[rgba(88,166,255,0.22)] text-blue' : t.cls === 'cty' ? 'bg-[rgba(63,185,80,0.07)] border-[rgba(63,185,80,0.22)] text-green' : 'bg-[rgba(188,140,255,0.07)] border-[rgba(188,140,255,0.22)] text-purple'}">${t.text}</span>`
          ).join('') : '';
          return `<div class="flex items-start gap-2.5 px-3 py-2.5 bg-surface border border-border rounded-lg">
            <div class="w-[18px] h-[18px] rounded-full bg-surface2 border border-border flex items-center justify-center font-mono text-[9px] text-text-muted shrink-0 mt-[1px]">${i + 1}</div>
            <div class="flex-1 min-w-0">
              <div class="font-mono text-[13px] text-purple font-medium mb-[5px] break-all">${ip}</div>
              <div class="flex flex-wrap gap-1.5" style="min-height:unset">${tags}</div>
            </div>
          </div>`;
        }).join('') +
      '</div>';
    } else {
      resolversHTML = '<div class="text-xs text-text-muted italic py-2 text-center">未捕获到任何 DNS 解析器 IP</div>';
    }

    setResultHTML(`
      <div class="inline-flex items-center gap-[7px] px-3 py-[5px] rounded-full text-xs font-medium mb-3.5 animate-fade-in ${badgeCls}">
        <span>${badgeIcon}</span>
        <span>${badgeText}</span>
      </div>
      ${resolversHTML}
    `);
  }

  return (
    <div class="mt-6 border border-border-muted rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-[13px] bg-surface">
        <div class="flex items-center gap-2 text-[13px] font-medium text-text">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-purple">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          DNS 泄漏检测
        </div>
        <button class="px-4 py-1.5 border border-border rounded-md bg-transparent text-text text-xs font-sans cursor-pointer transition-colors duration-200 shrink-0 hover:not-disabled:border-purple hover:not-disabled:text-purple hover:not-disabled:bg-[rgba(188,140,255,0.06)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={testing()} onClick={runLeakTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="px-[18px] py-4 pt-4 pb-[18px] bg-bg border-t border-border-muted">
          <Show when={progressVisible()}>
            <div class="flex items-center gap-2.5 text-xs text-text-muted mb-3">
              <span>{progressText()}</span>
              <div class="flex-1 h-[3px] bg-border-muted rounded-sm overflow-hidden">
                <div class="h-full bg-gradient-to-r from-purple to-blue rounded-sm transition-[width] duration-300 ease-in-out" style={{ width: `${progressWidth()}%` }}></div>
              </div>
            </div>
          </Show>
          <div innerHTML={resultHTML()}></div>
        </div>
      </Show>
    </div>
  );
}
