import { createSignal, Show } from 'solid-js';
import { escapeHTML } from '../lib/api';

// ── Data source fetchers ─────────────────────────────────────────

async function fetchLocal(): Promise<any> {
  const resp = await fetch('/api/ip-type', { cache: 'no-store' });
  const d = await resp.json();
  if (d.error) throw new Error(d.error);
  return {
    ip: d.ip, country: d.country, city: d.city,
    asn: d.asn ? `AS${d.asn}` : '', org: d.asn_org || '',
    type: d.type_cn, proxy: d.type === 'vpn' || d.type === 'datacenter',
    score: d.score, reasons: d.reasons, ptr: d.ptr,
    rawType: d.type,
  };
}

async function fetchIpinfo(): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch('https://ipinfo.io/json', { signal: ctrl.signal });
    const d = await resp.json();
    clearTimeout(timer);
    const orgParts = (d.org || '').split(' ');
    const asn = orgParts[0] || '';
    const org = orgParts.slice(1).join(' ') || d.org || '';
    return {
      ip: d.ip, country: d.country || '', city: d.city || '',
      asn: asn, org: org, region: d.region || '',
      type: d.company?.type || '', hostname: d.hostname || '',
    };
  } finally { clearTimeout(timer); }
}

async function fetchIpApi(): Promise<any> {
  const resp = await fetch('/api/ip-check', { cache: 'no-store' });
  const d = await resp.json();
  if (d.error) throw new Error(d.error);
  const asParts = (d.as || '').split(' ');
  return {
    ip: d.query, country: d.country || '', city: d.city || '',
    asn: asParts[0] || '', org: d.org || d.isp || '',
    isp: d.isp || '', proxy: !!d.proxy, hosting: !!d.hosting, mobile: !!d.mobile,
    type: d.hosting ? '机房' : d.proxy ? '代理' : d.mobile ? '移动' : '住宅',
  };
}

async function fetchCloudflare(): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: ctrl.signal });
    const text = await resp.text();
    clearTimeout(timer);
    const kv: Record<string, string> = {};
    text.trim().split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      kv[k!] = v.join('=');
    });
    return {
      ip: kv.ip || '', country: kv.loc || '', colo: kv.colo || '',
      warp: kv.warp || 'off', gateway: kv.gateway || '',
      type: kv.warp === 'on' ? 'WARP VPN' : '',
    };
  } finally { clearTimeout(timer); }
}

// ── Render helper ────────────────────────────────────────────────

function renderIPTypeResults(r: Record<string, any>): string {
  const local = r.local || {};
  const ipinfo = r.ipinfo || {};
  const ipapi = r.ipapi || {};
  const cf = r.cf || {};

  const cell = (val: string, err?: string) => {
    if (err) return `<td class="iptype-pending">❌ ${escapeHTML(err)}</td>`;
    return `<td>${val || '<span class="iptype-pending">—</span>'}</td>`;
  };

  // Consistency check
  const ips = [local.ip, ipinfo.ip, ipapi.ip, cf.ip].filter(Boolean);
  const uniqueIPs = [...new Set(ips)];
  const ipConsistent = uniqueIPs.length <= 1;

  const countries = [local.country, ipinfo.country, ipapi.country, cf.country].filter(Boolean);
  const uniqueCountries = [...new Set(countries.map((c: string) => c.toUpperCase()))];
  const countryConsistent = uniqueCountries.length <= 1;

  // Type/proxy display
  const typeIcons: Record<string, string> = { residential: '🏠', datacenter: '🖥️', vpn: '🛡️', mobile: '📱' };
  const typeColors: Record<string, string> = { residential: 'tag-residential', datacenter: 'tag-datacenter', vpn: 'tag-vpn', mobile: 'tag-mobile' };
  const icon = typeIcons[local.rawType] || '❓';
  const tagClass = typeColors[local.rawType] || '';

  const scoreColor = (local.score || 0) >= 70 ? '#22c55e' : (local.score || 0) >= 40 ? '#f59e0b' : '#ef4444';
  const scoreLabel = (local.score || 0) >= 70 ? '优质 IP' : (local.score || 0) >= 40 ? '一般' : '低质量 / 高风险';

  let html = '';

  // Top summary
  if (!local.error) {
    html += `
      <div class="iptype-badge">${icon} <span class="tag ${tagClass}">${escapeHTML(local.type)}</span></div>
      <div class="iptype-score-bar"><div class="iptype-score-fill" style="width:${local.score}%;background:${scoreColor}"></div></div>
      <div class="iptype-score-label">IP 质量评分: <strong>${local.score}/100</strong> — ${scoreLabel}</div>
    `;
  }

  // Multi-source comparison table
  html += `<div class="iptype-compare"><table>
    <tr><th>数据源</th><th>IP 地址</th><th>国家</th><th>城市</th><th>ASN / ISP</th><th>类型/代理</th></tr>
    <tr>
      <td class="src-name">🗄️ 本站 MaxMind</td>
      ${cell(local.error ? '' : escapeHTML(local.ip), local.error)}
      ${cell(local.error ? '' : escapeHTML(local.country), local.error)}
      ${cell(local.error ? '' : escapeHTML(local.city), local.error)}
      ${cell(local.error ? '' : `${escapeHTML(local.asn)} ${escapeHTML(local.org)}`, local.error)}
      ${cell(local.error ? '' : escapeHTML(local.type), local.error)}
    </tr>
    <tr>
      <td class="src-name">ℹ️ ipinfo.io</td>
      ${cell(ipinfo.error ? '' : escapeHTML(ipinfo.ip), ipinfo.error)}
      ${cell(ipinfo.error ? '' : escapeHTML(ipinfo.country), ipinfo.error)}
      ${cell(ipinfo.error ? '' : escapeHTML(ipinfo.city), ipinfo.error)}
      ${cell(ipinfo.error ? '' : `${escapeHTML(ipinfo.asn)} ${escapeHTML(ipinfo.org)}`, ipinfo.error)}
      ${cell(ipinfo.error ? '' : (ipinfo.type || '—'), ipinfo.error)}
    </tr>
    <tr>
      <td class="src-name">🌐 ip-api.com</td>
      ${cell(ipapi.error ? '' : escapeHTML(ipapi.ip), ipapi.error)}
      ${cell(ipapi.error ? '' : escapeHTML(ipapi.country), ipapi.error)}
      ${cell(ipapi.error ? '' : escapeHTML(ipapi.city), ipapi.error)}
      ${cell(ipapi.error ? '' : `${escapeHTML(ipapi.asn)} ${escapeHTML(ipapi.isp || ipapi.org)}`, ipapi.error)}
      ${cell(ipapi.error ? '' : escapeHTML(ipapi.type), ipapi.error)}
    </tr>
    <tr>
      <td class="src-name">☁️ Cloudflare</td>
      ${cell(cf.error ? '' : escapeHTML(cf.ip), cf.error)}
      ${cell(cf.error ? '' : escapeHTML(cf.country), cf.error)}
      ${cell(cf.error ? '' : (cf.colo ? `边缘节点: ${escapeHTML(cf.colo)}` : '—'), cf.error)}
      ${cell('—')}
      ${cell(cf.error ? '' : (cf.warp === 'on' ? '<span class="iptype-mismatch">WARP VPN</span>' : '未使用 WARP'), cf.error)}
    </tr>
  </table></div>`;

  // Consistency summary
  const issues: string[] = [];
  if (!ipConsistent) issues.push(`IP 地址不一致: ${uniqueIPs.join(' vs ')}`);
  if (!countryConsistent) issues.push(`国家判定不一致: ${uniqueCountries.join(' vs ')}`);

  if (issues.length === 0) {
    html += `<div class="iptype-summary"><span style="color:var(--green)">✅</span> 所有数据源结果一致，未发现异常</div>`;
  } else {
    html += `<div class="iptype-summary" style="border-left:3px solid var(--red)">
      <span style="color:var(--red)">⚠️</span>
      <div>${issues.map(i => `<div>${escapeHTML(i)}</div>`).join('')}
      <div style="color:var(--text-muted);margin-top:4px">不一致可能由代理、VPN 或 CDN 导致</div></div>
    </div>`;
  }

  // PTR + analysis reasons
  if (local.reasons && local.reasons.length > 0) {
    html += `<ul class="iptype-reasons">${local.reasons.map((rr: string) => `<li><span style="color:var(--cyan)">▸</span> ${escapeHTML(rr)}</li>`).join('')}</ul>`;
  }

  return html;
}

// ── Component ────────────────────────────────────────────────────

export default function IPTypeSection() {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [bodyHTML, setBodyHTML] = createSignal('');
  const [btnText, setBtnText] = createSignal('开始检测');

  async function runIPTypeTest() {
    setTesting(true);
    setBtnText('检测中…');
    setBodyVisible(true);
    setBodyHTML('<div style="color:var(--text-muted);font-size:12px;padding:4px 0">正在查询 4 个数据源…</div>');

    const sources = [
      { key: 'local',  fn: fetchLocal },
      { key: 'ipinfo', fn: fetchIpinfo },
      { key: 'ipapi',  fn: fetchIpApi },
      { key: 'cf',     fn: fetchCloudflare },
    ];

    const results: Record<string, any> = {};

    const promises = sources.map(async (src) => {
      try {
        results[src.key] = await src.fn();
      } catch (e: any) {
        results[src.key] = { error: e.message };
      }
    });
    await Promise.allSettled(promises);

    setBodyHTML(renderIPTypeResults(results));
    setTesting(false);
    setBtnText('重新检测');
  }

  return (
    <div class="iptype-section">
      <div class="iptype-header">
        <div class="iptype-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--cyan)">
            <circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>
          </svg>
          IP 类型 / 多源对比
        </div>
        <button class="btn-iptype" disabled={testing()} onClick={runIPTypeTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="iptype-body" innerHTML={bodyHTML()}></div>
      </Show>
    </div>
  );
}
