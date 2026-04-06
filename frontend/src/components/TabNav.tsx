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
    <div class="flex gap-0.5 bg-surface border border-border rounded-[10px] p-1 mt-4 mb-1">
      {TABS.map(tab => (
        <button
          class={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[7px] font-sans text-xs font-medium cursor-pointer transition-all duration-200 whitespace-nowrap hover:text-text hover:bg-surface2 max-[500px]:text-[11px] max-[500px]:px-1.5 max-[500px]:py-2 max-[500px]:gap-1 ${props.activeTab() === tab.id ? 'bg-surface2 text-text-bright border border-border' : 'bg-transparent text-text-muted border border-transparent'}`}
          onClick={() => props.setActiveTab(tab.id)}
        >
          <span class="text-sm max-[500px]:text-base">{tab.icon}</span>
          <span class="max-[500px]:hidden">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
