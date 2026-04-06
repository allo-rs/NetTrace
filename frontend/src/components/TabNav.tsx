import type { Accessor, Setter } from 'solid-js';

interface TabNavProps {
  activeTab: Accessor<string>;
  setActiveTab: Setter<string>;
}

const TABS = [
  { id: 'tab-network',     icon: '🌐', label: '网络信息' },
  { id: 'tab-performance', icon: '⚡', label: '性能测试' },
  { id: 'tab-security',    icon: '🔒', label: '安全隐私' },
] as const;

export default function TabNav(props: TabNavProps) {
  return (
    <div class="tab-nav">
      {TABS.map(tab => (
        <button
          class={`tab-btn ${props.activeTab() === tab.id ? 'active' : ''}`}
          onClick={() => props.setActiveTab(tab.id)}
        >
          <span class="tab-icon">{tab.icon}</span>
          <span class="tab-label">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
