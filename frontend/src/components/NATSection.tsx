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

      // Render result
      setResultHTML(`
        <div class="nat-result">
          <div class="nat-type-badge ${info.cls}">${info.icon} ${info.label}</div>
        </div>
        <div class="nat-desc">${info.desc}</div>`);

      // Render details
      let dHTML = '';

      if (mappedIP) {
        dHTML += `
          <div class="nat-detail-card">
            <div class="nat-detail-label">公网映射 IP</div>
            <div class="nat-detail-value">${mappedIP}</div>
          </div>`;
      }

      if (mappedPort1 && mappedPort2) {
        dHTML += `
          <div class="nat-detail-card">
            <div class="nat-detail-label">端口映射</div>
            <div class="nat-detail-value">STUN1: ${mappedPort1} / STUN2: ${mappedPort2}${mappedPort1 === mappedPort2 ? ' (一致)' : ' (不一致)'}</div>
          </div>`;
      }

      const localIPs = uniqueHostIPs.filter(ip => !isPublicIP(ip));
      if (localIPs.length > 0) {
        dHTML += `
          <div class="nat-detail-card">
            <div class="nat-detail-label">本地接口</div>
            <div class="nat-detail-value">${localIPs.join(', ')}</div>
          </div>`;
      }

      dHTML += `
        <div class="nat-detail-card">
          <div class="nat-detail-label">候选地址统计</div>
          <div class="nat-detail-value">Host: ${allHosts.length} / SRFLX: ${srflx1.length + srflx2.length}</div>
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
    <div class="nat-section">
      <div class="nat-header">
        <div class="nat-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--yellow)">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          NAT 类型检测
        </div>
        <button class="btn-nat" disabled={testing()} onClick={runNATTest}>{btnText()}</button>
      </div>
      <Show when={bodyVisible()}>
        <div class="nat-body">
          <div innerHTML={resultHTML()}></div>
          <div class="nat-details" innerHTML={detailsHTML()}></div>
          <Show when={noteVisible()}>
            <div class="nat-note">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px">
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
