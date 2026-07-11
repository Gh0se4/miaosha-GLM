<script lang="ts">
  const README_BASICS = [
    { index: '01', title: '10:00:00.000 是每日默认 target time', detail: '所有默认时间统一对齐到 UTC+8 10:00:00.000；页面展示时间、提醒时间和自动 Fire 触发点都以此为基准。' },
    { index: '02', title: '验证码可以提前囤，单个 ticket 有效 300 秒', detail: 'Tencent CAPTCHA 支持提前请求，扩展会把可用 ticket 放入池中统一管理，但超过 300 秒的旧 ticket 会被淘汰，避免把过期弹药带进真实发射。' },
    { index: '03', title: '自动 Fire 使用单线程顺序 Burst', detail: '到达 sale time 后，把当前可用 ticket 按过期紧急度排序后，以 burstIntervalMs（默认 2100ms）为间隔一枪一枪顺序发射；任意一枪拿到 bizId 立即停止。' },
    { index: '04', title: '以用户配置的 sale time 为唯一自动触发点', detail: '不再维护独立的 soldOut 探测或"提前放量"逻辑。系统只在 sale time 到来时按已选商品优先级自动开火，配合实测 latency 做提前量补偿。' },
  ];

  const README_STRATEGY = [
    { phase: 'T-60', title: '提醒与验证码准备窗口打开', detail: '从 T-60 起系统通知、角标倒计时和页面提醒开始生效。重点是确认链路在线、商品选择正确，以及验证码池开始积累。' },
    { phase: 'T-30', title: '继续囤 ticket', detail: 'T-30 到 T-15 之间继续收集验证码 ticket，并保持页面、popup、background 三条链路对同一 sale time 的一致认知。' },
    { phase: 'T-15', title: '进入最后准备', detail: 'T-15 到 T-5 是敏感窗口，重点是确保已选商品优先级和 ticket 数量满足预期发射计划。' },
    { phase: 'T-5', title: '边界点而不是普通提醒点', detail: 'T-5 到来时最终提醒触发。此后用户应集中录入验证码，系统将在 sale time 自动进入顺序 Burst 发射阶段。' },
    { phase: 'FIRE', title: 'sale time 自动开火', detail: '到达 sale time 后，content script 按优先级配比分配 ticket，以单线程顺序 Burst 射击；连续 555 时退避，命中或弹药用尽时结束。' },
  ];
</script>

<div class="page-stack">
  <section class="section-card">
    <div class="section-heading">
      <span class="accent-bar" style="background: linear-gradient(180deg, var(--violet), var(--primary)); box-shadow: 0 0 14px rgba(99,102,241,0.35);"></span>
      <h3>工作原理</h3>
    </div>
    <p class="section-note">抢购时间轴、发射策略与 soldOut 探测逻辑的完整说明。</p>

    <div class="readme-panel">
      <div class="doc-hero">
        <span class="doc-badge">PART A</span>
        <h4>基本信息</h4>
        <p>把 ready 时刻、库存释放展示、验证码 TTL 与发射边界放在同一条时间轴里，先统一语义，再配置参数。</p>
      </div>

      <div class="principles-grid">
        {#each README_BASICS as item}
          <article class="principle-card">
            <span class="principle-index">{item.index}</span>
            <h5>{item.title}</h5>
            <p>{item.detail}</p>
          </article>
        {/each}
      </div>

      <div class="doc-hero doc-hero-secondary">
        <span class="doc-badge">PART B</span>
        <h4>发射策略</h4>
        <p>把探测、提醒、验证码准备和自动开火明确拆成一条有边界的流程，而不是把所有动作堆在最终几秒钟里。</p>
      </div>

      <div class="strategy-list">
        {#each README_STRATEGY as step}
          <article class="strategy-card">
            <div class="strategy-phase">{step.phase}</div>
            <div class="strategy-content">
              <h5>{step.title}</h5>
              <p>{step.detail}</p>
            </div>
          </article>
        {/each}
      </div>
    </div>
  </section>
</div>

<style>
  .page-stack { display: flex; flex-direction: column; gap: 24px; }

  .section-card {
    background: linear-gradient(135deg, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0.24) 100%);
    border: 1px solid var(--panel-border);
    border-top-color: rgba(255,255,255,0.88);
    border-left-color: rgba(255,255,255,0.88);
    box-shadow: var(--card-shadow);
    border-radius: var(--radius-xl);
    padding: 28px 30px;
    position: relative;
    overflow: hidden;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }
  @media (prefers-color-scheme: dark) {
    .section-card {
      background: linear-gradient(135deg, rgba(30,41,59,0.78) 0%, rgba(15,23,42,0.52) 100%);
      border-top-color: rgba(255,255,255,0.12);
      border-left-color: rgba(255,255,255,0.12);
    }
  }
  .section-card::before {
    content: '';
    position: absolute;
    inset: -80px auto auto -80px;
    width: 200px; height: 200px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(16,185,129,0.09), transparent 68%);
    pointer-events: none;
  }

  .section-heading { display: flex; align-items: center; gap: 12px; margin: 0 0 8px; position: relative; z-index: 1; }
  .accent-bar { width: 6px; height: 26px; border-radius: 999px; background: var(--primary); box-shadow: 0 0 14px rgba(16,185,129,0.35); flex: 0 0 auto; }
  .section-heading h3 { margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--text-strong); letter-spacing: -0.02em; }
  .section-note { margin: 0 0 24px 18px; color: var(--text-muted); font-size: 13px; line-height: 1.6; position: relative; z-index: 1; }

  .readme-panel { display: flex; flex-direction: column; gap: 20px; position: relative; z-index: 1; }

  .doc-hero { padding: 22px 24px; border-radius: 22px; border: 1px solid rgba(99,102,241,0.18); background: linear-gradient(135deg, rgba(99,102,241,0.12), rgba(16,185,129,0.08)); }
  .doc-hero-secondary { border-color: rgba(16,185,129,0.18); background: linear-gradient(135deg, rgba(16,185,129,0.12), rgba(14,165,233,0.08)); }
  .doc-badge { display: inline-flex; align-self: flex-start; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.58); border: 1px solid rgba(255,255,255,0.72); color: var(--violet); font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
  .doc-hero h4 { margin: 10px 0 8px; font-size: 1.35rem; font-weight: 800; color: var(--text-strong); letter-spacing: -0.03em; }
  .doc-hero p { margin: 0; color: var(--text-main); font-size: 14px; line-height: 1.7; }

  .principles-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .principle-card, .strategy-card { border-radius: 20px; border: 1px solid var(--panel-border-soft); background: rgba(255,255,255,0.4); box-shadow: 0 12px 28px rgba(118,136,158,0.1); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
  @media (prefers-color-scheme: dark) { .principle-card, .strategy-card { background: rgba(15,23,42,0.42); } }
  .principle-card { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .principle-index { display: inline-flex; align-self: flex-start; padding: 4px 9px; border-radius: 999px; background: rgba(99,102,241,0.12); color: var(--violet); font-size: 11px; font-weight: 800; letter-spacing: 0.12em; }
  .principle-card h5, .strategy-content h5 { margin: 0; color: var(--text-strong); font-weight: 800; letter-spacing: -0.02em; font-size: 1rem; }
  .principle-card p, .strategy-content p { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.7; }

  .strategy-list { display: flex; flex-direction: column; gap: 14px; }
  .strategy-card { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 16px; padding: 18px 20px; align-items: start; }
  .strategy-phase { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 8px 12px; border-radius: 14px; background: linear-gradient(135deg, rgba(99,102,241,0.16), rgba(14,165,233,0.12)); color: var(--violet); font-size: 12px; font-weight: 800; letter-spacing: 0.12em; }
  .strategy-content { display: flex; flex-direction: column; gap: 8px; }

  @media (max-width: 960px) { .principles-grid { grid-template-columns: 1fr; } .strategy-card { grid-template-columns: 1fr; } .strategy-phase { justify-self: start; min-width: 92px; } }
</style>
