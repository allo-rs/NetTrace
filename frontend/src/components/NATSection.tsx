import { createSignal, Show } from 'solid-js';
import { isPublicIP } from '../lib/api';

const NAT_TYPES: Record<string, { label: string; cls: string; icon: string; desc: string }> = {
  open:       { label: '开放网络',      cls: 'open',       icon: '🟢', desc: '无 NAT，直接使用公网 IP。所有网络应用均可正常使用。' },
  fullcone:   { label: '完全锥形 NAT',  cls: 'fullcone',   icon: '🟢', desc: 'NAT 映射对所有外部主机开放，P2P 连接友好，游戏和视频通话正常。' },
  restricted: { label: '受限锥形 NAT',  cls: 'restricted', icon: '🟡', desc: 'NAT 仅允许已通信的主机回连，大部分应用正常，部分 P2P 可能需要中继。' },
  symmetric:  { label: '对称型 NAT',    cls: 'symmetric',  icon: '🔴', desc: '每个目标使用不同端口映射，P2P 连接困难，视频通话和游戏可能需要 TURN 中继服务器。' },
  blocked:    { label: 'UDP 被阻止',    cls: 'blocked',    icon: '🔴', desc: '无法建立 UDP 连接，可能被防火墙或运营商限制。VoIP、游戏等实时应用可能异常。' }
};

interface CandidateInfo {
  host: { ip: string; port: number; protocol: string }[];
  srflx: { ip: string; port: number; protocol: string; relatedAddress?: string }[];
}

async function gatherCandidates(stunServer: string): Promise<CandidateInfo> {
  return new Promise((resolve) => {
    const candidates: CandidateInfo = { host: [], srflx: [] };
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: stunServer }]
    });

    const timeout = setTimeout(() => {
      pc.close();
      resolve(candidates);
    }, 8000);

    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        clearTimeout(timeout);
        pc.close();
        resolve(candidates);
        return;
      }
      const c = e.candidate;
      if (c.type === 'host' && c.address) {
        candidates.host.push({ ip: c.address, port: c.port!, protocol: c.protocol! });
      } else if (c.type === 'srflx' && c.address) {
        candidates.srflx.push({ ip: c.address, port: c.port!, protocol: c.protocol!, relatedAddress: c.relatedAddress || undefined });
      }
    };

    pc.createDataChannel('nat-test');
    pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {
      clearTimeout(timeout);
      pc.close();
      resolve(candidates);
    });
  });
}

export default function NATSection() {
  const [testing, setTesting] = createSignal(false);
  const [bodyVisible, setBodyVisible] = createSignal(false);
  const [resultHTML, setResultHTML] = createSignal('');
  const [detailsHTML, setDetailsHTML] = createSignal('');
  const [noteVisible, setNoteVisible] = createSignal(false);
  const [btnText, setBtnText] = createSignal('开始检测');

  async function runNATTest() {
    setTesting(true);
    setBtnText('检测中…');
    setBodyVisible(true);
    setResultHTML('<span style="color:var(--text-muted);font-size:12px">正在通过 STUN 服务器探测…</span>');
    setDetailsHTML('');
    setNoteVisible(false);

    try {
      // Gather from two different STUN servers
      const [c1, c2] = await Promise.all([
        gatherCandidates('stun:stun.l.google.com:19302'),
        gatherCandidates('stun:stun1.l.google.com:19302')
      ]);

      // Merge host candidates
      const allHosts = [...c1.host, ...c2.host];
      const uniqueHostIPs = [...new Set(allHosts.map(h => h.ip))];
      const publicHosts = uniqueHostIPs.filter(isPublicIP);

      const srflx1 = c1.srflx;
      const srflx2 = c2.srflx;

      let natType: string;
      let mappedIP: string | null = null;
      let mappedPort1: number | null = null;
      let mappedPort2: number | null = null;

      if (srflx1.length === 0 && srflx2.length === 0) {
        if (publicHosts.length > 0) {
          natType = 'open';
          mappedIP = publicHosts[0]!;
        } else {
          natType = 'blocked';
        }
      } else {
        const s1 = srflx1[0];
        const s2 = srflx2[0];

        if (s1 && s2) {
          mappedIP = s1.ip;
          mappedPort1 = s1.port;
          mappedPort2 = s2.port;

          if (s1.ip === s2.ip && s1.port === s2.port) {
            natType = 'fullcone';
          } else if (s1.ip === s2.ip && s1.port !== s2.port) {
            natType = 'symmetric';
          } else {
            natType = 'symmetric';
          }
        } else {
          const s = s1 || s2;
          mappedIP = s!.ip;
          natType = 'restricted';
        }
      }

      const info = NAT_TYPES[natType]!;

      // Badge color mapping
      const badgeColors: Record<string, string> = {
        open: 'bg-[rgba(63,185,80,0.1)] text-green border border-[rgba(63,185,80,0.25)]',
        fullcone: 'bg-[rgba(63,185,80,0.1)] text-green border border-[rgba(63,185,80,0.25)]',
        restricted: 'bg-[rgba(227,179,65,0.1)] text-yellow border border-[rgba(227,179,65,0.25)]',
        symmetric: 'bg-[rgba(248,81,73,0.1)] text-red border border-[rgba(248,81,73,0.2)]',
        blocked: 'bg-[rgba(248,81,73,0.1)] text-red border border-[rgba(248,81,73,0.2)]',
      };
      const badgeCls = badgeColors[natType] || '';

      // Render result
      setResultHTML(`
        <div class="flex items-center gap-3 mb-3.5">
          <div class="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold ${badgeCls}">${info.icon} ${info.label}</div>
        </div>
        <div class="text-xs text-text-muted mb-3 leading-normal">${info.desc}</div>`);

      // Render details
      let dHTML = '';

      if (mappedIP) {
        dHTML += `
          <div class="bg-surface2 border border-border-muted rounded-lg px-3.5 py-2.5">
            <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-0.5">公网映射 IP</div>
            <div class="font-mono text-xs text-text-bright break-all">${mappedIP}</div>
          </div>`;
      }

      if (mappedPort1 && mappedPort2) {
        dHTML += `
          <div class="bg-surface2 border border-border-muted rounded-lg px-3.5 py-2.5">
            <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-0.5">端口映射</div>
            <div class="font-mono text-xs text-text-bright break-all">STUN1: ${mappedPort1} / STUN2: ${mappedPort2}${mappedPort1 === mappedPort2 ? ' (一致)' : ' (不一致)'}</div>
          </div>`;
      }

      const localIPs = uniqueHostIPs.filter(ip => !isPublicIP(ip));
      if (localIPs.length > 0) {
        dHTML += `
          <div class="bg-surface2 border border-border-muted rounded-lg px-3.5 py-2.5">
            <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-0.5">本地接口</div>
            <div class="font-mono text-xs text-text-bright break-all">${localIPs.join(', ')}</div>
          </div>`;
      }

      dHTML += `
        <div class="bg-surface2 border border-border-muted rounded-lg px-3.5 py-2.5">
          <div class="text-[11px] text-text-muted uppercase tracking-[0.5px] mb-0.5">候选地址统计</div>
          <div class="font-mono text-xs text-text-bright break-all">Host: ${allHosts.length} / SRFLX: ${srflx1.length + srflx2.length}</div>
        </div>`;

      setDetailsHTML(dHTML);

    } catch (e: any) {
      setResultHTML(`<div style="color:var(--red);font-size:12px">检测失败: ${e.message || '浏览器不支持 WebRTC'}</div>`);
    } finally {
      setNoteVisible(true);
      setTesting(false);
      setBtnText('重新检测');
    }
  }

  return (
    <div class="mt-4 bg-surface border border-border rounded-[10px] overflow-hidden">
      <div class="flex items-center justify-between px-[18px] py-3.5 gap-3">
        <div class="flex items-center gap-2 font-medium text-[13px] text-text-bright">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yellow">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          NAT 类型检测
        </div>
        <button class="bg-transparent border border-border rounded-md text-yellow text-xs px-3.5 py-[5px] cursor-pointer whitespace-nowrap transition-colors duration-150 hover:not-disabled:bg-[rgba(227,179,65,0.08)] hover:not-disabled:border-[rgba(227,179,65,0.4)] disabled:opacity-40 disabled:cursor-not-allowed" disabled={testing()} onClick={runNATTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="px-[18px] pb-4">
          <div innerHTML={resultHTML()}></div>
          <div class="grid grid-cols-2 gap-2.5 max-[500px]:grid-cols-1" innerHTML={detailsHTML()}></div>
          <Show when={noteVisible()}>
            <div class="flex items-start gap-1.5 text-[11px] text-text-muted mt-3 leading-normal">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>NAT 类型通过 WebRTC ICE 候选地址分析判断。对称型 NAT 可能影响 P2P 连接（如视频通话、游戏联机）。检测结果仅供参考。</span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
