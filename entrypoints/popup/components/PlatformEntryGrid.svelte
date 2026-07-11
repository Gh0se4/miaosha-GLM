<script lang="ts">
  import { platformRegistry, type IPlatformAdapter } from '../../../lib/platform';

  function openEntry(url: string) {
    chrome.tabs.create({ url });
  }

  type SubEntry = {
    id: string;
    name: string;
    entryUrl: string;
    hostHint: string;
    note?: string;
  };

  const ENTRY_NOTES: Record<string, string> = {
    'volcengine-agentplan': '无需抢购，音乐/视频可用，但用户普遍反馈较差',
    'volcengine-codingplan': '不定时释放库存，需刷新库存',
    'bailian-codingplan': 'UTC+8 09:30 开售 · 200 元起 · 略贵',
  };

  type PlatformGroup = {
    id: string;
    hostHint: string;
    subEntries: SubEntry[];
  };

  /**
   * Group adapters by host root so Volcengine Agent Plan + Coding Plan
   * collapse into a single card with multiple sub-rows.
   */
  function groupAdapters(adapters: readonly IPlatformAdapter[]): PlatformGroup[] {
    const groups = new Map<string, PlatformGroup>();
    for (const a of adapters) {
      const hostRoot = (a.hostPatterns[0] ?? '').replace(/^\*:\/\/\*\./, '').replace(/\/\*$/, '');
      const existing = groups.get(hostRoot);
      const sub: SubEntry = {
        id: a.id,
        name: a.displayName,
        entryUrl: a.entryUrl,
        hostHint: hostRoot,
        note: ENTRY_NOTES[a.id],
      };
      if (existing) {
        existing.subEntries.push(sub);
      } else {
        groups.set(hostRoot, { id: hostRoot, hostHint: hostRoot, subEntries: [sub] });
      }
    }
    return Array.from(groups.values());
  }

  const groups = $derived(groupAdapters(platformRegistry.list()));

  /**
   * Static "Coming Soon" entry for 阿里百炼 — surfaced even though no
   * adapter is registered yet. Keeps the layout stable while the
   * platform integration ships.
   */
  const upcoming = {
    name: '阿里百炼 Coding Plan',
    hostHint: 'bailian.com.cn',
    note: ENTRY_NOTES['bailian-codingplan'],
  };
</script>

<div class="list">
  {#each groups as group, idx (group.id)}
    {#if group.subEntries.length === 1}
      <!-- 单入口卡 (Hero) -->
      {@const sub = group.subEntries[0]}
      <article class="card hero">
        <header class="hero-head">
          <span class="rocket" aria-hidden="true">🚀</span>
          <div class="meta">
            <h2 class="name">{sub.name}</h2>
            <p class="host">*.{group.hostHint}</p>
          </div>
          <span class="num">{String(idx + 1).padStart(2, '0')}</span>
        </header>
        <button class="cta primary" onclick={() => openEntry(sub.entryUrl)}>
          ▶ 一键开始抢购
        </button>
      </article>
    {:else}
      <!-- 多入口卡 (Group) -->
      <article class="card group">
        <header class="group-head">
          <span class="rocket" aria-hidden="true">🚀</span>
          <div class="meta">
            <h2 class="name">火山引擎</h2>
            <p class="host">*.{group.hostHint} · 多入口</p>
          </div>
          <span class="num">{String(idx + 1).padStart(2, '0')}</span>
        </header>
        <div class="sub-list">
          {#each group.subEntries as sub (sub.id)}
            <div class="sub-row">
              <div class="sub-meta">
                <div class="sub-name">{sub.name}</div>
                {#if sub.note}
                  <div class="sub-note">{sub.note}</div>
                {/if}
              </div>
              <button class="cta secondary" onclick={() => openEntry(sub.entryUrl)}>
                ▶ 进入
              </button>
            </div>
          {/each}
        </div>
      </article>
    {/if}
  {/each}

  <!-- Coming-soon 卡片（整张平台尚未接入） -->
  <div class="card locked" role="group" aria-label="阿里百炼 Coding Plan 敬请期待">
    <span class="rocket muted" aria-hidden="true">🚀</span>
    <div class="meta">
      <h2 class="name">{upcoming.name}</h2>
      <p class="host">*.{upcoming.hostHint} · 敬请期待</p>
      <p class="sub-note">{upcoming.note}</p>
    </div>
    <button class="cta disabled" disabled>通知我</button>
  </div>
</div>

<style>
  .list {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 14px 12px;
    overflow: hidden;
  }

  /* ── 卡片基类：黑边 + 硬偏移阴影 + 方角 ── */
  .card {
    position: relative;
    background: #ffffff;
    border: 1.5px solid #0c1224;
    border-radius: 12px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 3px 3px 0 0 #0c1224;
  }

  /* ── 火箭 + 元信息 ── */
  .rocket {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border: 1.5px solid #0c1224;
    border-radius: 8px;
    display: grid;
    place-items: center;
    font-size: 16px;
    background: #fafaf7;
    line-height: 1;
  }
  .rocket.muted {
    opacity: 0.55;
    border-style: dashed;
  }

  .meta {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-family: 'Plus Jakarta Sans', 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #0c1224;
    line-height: 1.25;
    letter-spacing: -0.2px;
  }
  .host {
    margin-top: 2px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #6a7496;
  }

  /* ── 右上角编号印章（方角、单边框） ── */
  .num {
    flex-shrink: 0;
    align-self: flex-start;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    color: #0c1224;
    letter-spacing: 0.1em;
    padding: 2px 6px;
    border: 1px solid #0c1224;
    border-radius: 4px;
    background: #fafaf7;
  }

  /* ── Hero（占视觉中心的大卡） ── */
  .card.hero { flex: 0 0 auto; }
  .hero-head { display: flex; align-items: center; gap: 10px; }
  .card.hero .name { font-size: 16px; font-weight: 800; }

  /* ── Group（中卡，嵌套多个子入口） ── */
  .card.group { flex: 1; min-height: 0; }
  .group-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 8px;
    border-bottom: 1px dashed rgba(12, 18, 36, 0.2);
  }
  .sub-list { display: flex; flex-direction: column; gap: 6px; }
  .sub-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 2px;
  }
  .sub-name {
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 700;
    color: #0c1224;
  }
  .sub-note {
    margin-top: 2px;
    font-family: 'Inter', sans-serif;
    font-size: 9px;
    line-height: 1.3;
    color: #6a7496;
  }

  /* ── Locked（Coming soon 紧凑卡） ── */
  .card.locked {
    flex: 0 0 auto;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: #fafaf7;
    border-style: dashed;
    box-shadow: none;
  }
  .card.locked .name { font-size: 12px; color: #6a7496; }

  /* ── CTA：黑底白字 / 米白底黑字（无渐变） ── */
  .cta {
    flex-shrink: 0;
    border: 1.5px solid #0c1224;
    border-radius: 8px;
    font-family: 'Inter', sans-serif;
    font-weight: 800;
    cursor: pointer;
    padding: 8px 14px;
    font-size: 11px;
    background: #0c1224;
    color: #f5f3ee;
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  .cta.primary {
    width: 100%;
    padding: 10px 0;
    font-size: 12px;
  }
  .cta.secondary {
    padding: 6px 12px;
    font-size: 10px;
    background: #fafaf7;
    color: #0c1224;
  }
  .cta:hover:not(:disabled) {
    transform: translate(-1px, -1px);
    box-shadow: 2px 2px 0 0 #0c1224;
  }
  .cta.disabled,
  .cta:disabled {
    background: #fafaf7;
    color: #6a7496;
    border-style: dashed;
    cursor: not-allowed;
  }
</style>