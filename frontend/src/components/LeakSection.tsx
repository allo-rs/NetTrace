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
      setResultHTML('<div class="leak-no-capture">请求失败，请稍后重试</div>');
      return;
    }

    // Notify parent of detected client IP
    if (data.client_ip && props.onClientIP) {
      props.onClientIP(data.client_ip);
    }

    const captured = data.captured_count;
    const total = data.total_count;
    const unique: string[] = data.unique_resolvers || [];

    let badgeClass: string, badgeIcon: string, badgeText: string;
    if (captured === 0) {
      badgeClass = 'partial'; badgeIcon = '⚠'; badgeText = '未能捕获任何探针（可能启用了 DoH）';
    } else if (data.leaked) {
      badgeClass = 'leaked'; badgeIcon = '✕'; badgeText = `检测到 ${unique.length} 个不同 DNS 解析器，存在泄漏风险`;
    } else if (captured < total) {
      badgeClass = 'partial'; badgeIcon = '△'; badgeText = `仅捕获 ${captured}/${total} 个探针，结果不完整`;
    } else {
      badgeClass = 'safe'; badgeIcon = '✓'; badgeText = '所有探针均通过同一 DNS 解析器，未发现泄漏';
    }

    let resolversHTML = '';
    if (unique.length > 0) {
      resolversHTML = '<div class="leak-resolvers">' +
        unique.map((ip: string, i: number) => {
          const result = data.results.find((r: any) => r.resolver_ip === ip);
          const geo = result && result.resolver_geo;
          const tags = geo ? geoToTags(geo).map(t =>
            `<span class="tag ${t.cls}">${t.text}</span>`
          ).join('') : '';
          return `<div class="leak-resolver-item">
            <div class="leak-resolver-idx">${i + 1}</div>
            <div class="leak-resolver-info">
              <div class="leak-resolver-ip">${ip}</div>
              <div class="tags" style="min-height:unset">${tags}</div>
            </div>
          </div>`;
        }).join('') +
      '</div>';
    } else {
      resolversHTML = '<div class="leak-no-capture">未捕获到任何 DNS 解析器 IP</div>';
    }

    setResultHTML(`
      <div class="leak-result-badge ${badgeClass} fade-in">
        <span>${badgeIcon}</span>
        <span>${badgeText}</span>
      </div>
      ${resolversHTML}
    `);
  }

  return (
    <div class="leak-section">
      <div class="leak-header">
        <div class="leak-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--purple)">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          DNS 泄漏检测
        </div>
        <button class="btn-leak" disabled={testing()} onClick={runLeakTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="leak-body">
          <Show when={progressVisible()}>
            <div class="leak-progress">
              <span>{progressText()}</span>
              <div class="leak-progress-bar-wrap">
                <div class="leak-progress-bar" style={{ width: `${progressWidth()}%` }}></div>
              </div>
            </div>
          </Show>
          <div innerHTML={resultHTML()}></div>
        </div>
      </Show>
    </div>
  );
}
