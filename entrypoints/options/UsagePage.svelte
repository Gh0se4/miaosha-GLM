<script lang="ts">
  const MODE_ROWS = [
    { name: 'Auto', meaning: '自动模式', behavior: '插件根据下一次抢购时间自动倒计时，并在 saleTime - RTT/2 - 40ms 触发 strike()，你只需提前准备好验证码。' },
    { name: 'Manual', meaning: '手动模式', behavior: '禁用自动倒计时，只有点击 FIRE 按钮才会发射；适合想自己把握时机测试或手动窗口。' },
  ];

  const FIELD_ROWS = [
    { field: 'Mode', desc: 'auto / manual，决定“什么时候发射”。' },
    { field: 'Burst Interval', desc: 'Burst 模式下每枪之间的间隔（ms）。推荐 2100ms。' },
    { field: 'Pay', desc: '传给 create-sign 的支付方式，ALI 或 WE_CHAT。' },
    { field: 'FIRE (0)', desc: '当前可发射次数；为 0 时禁用，提示选商品 / 录验证码。' },
    { field: 'Auth: pending', desc: '授权头状态；登录并刷新后会变绿。' },
    { field: 'T-xxx.xs', desc: 'auto 模式下距离自动发射的倒计时。' },
  ];

  const ERROR_ROWS = [
    { outcome: '成功', code: '200 + bizId', subject: '智谱', target: '插件', cause: '锁单成功，返回 bizId', note: ' Fire Matrix 变绿，自动打开支付页。' },
    { outcome: '售罄', code: '200 sold-out', subject: '智谱', target: '插件', cause: '该商品今日库存已售罄', note: '继续打其他优先级商品。' },
    { outcome: '限流', code: '555', subject: '智谱', target: '当前用户', cause: '2 秒滑动窗口限流（阈值=1）', note: '建议提高 Burst Interval ≥2100ms。' },
    { outcome: '验证码繁忙', code: '500', subject: '智谱', target: '腾讯验证码核销', cause: '超过《每秒并发请求量（QPS）限制》', note: '抢购瞬间大量请求涌入腾讯云导致，非插件 bug。' },
    { outcome: '验证码失效', code: '500', subject: '插件/用户', target: '腾讯验证码核销', cause: 'ticket 无效或已过期', note: '请重新录入验证码。' },
    { outcome: '验证码风控', code: '500', subject: '腾讯验证码风控', target: '当前请求', cause: '环境存在安全风险', note: '尝试刷新页面或更换浏览器环境。' },
    { outcome: '网络错误', code: '0 / network', subject: '插件/网络', target: '智谱', cause: '请求未到达服务端或连接超时', note: '检查网络或稍后重试。' },
    { outcome: '错误', code: '其他 500', subject: '智谱/网络', target: '插件', cause: '未知服务端错误', note: '查看 raw serverMsg 并反馈。' },
  ];

  const FLOW = [
    {
      phase: 'Preload',
      title: '准备阶段',
      items: [
        '用户在 sale time 前录入验证码 ticket，保存在当前 tab 的 sessionStorage。',
        '在 Target Products 里最多选 3 个商品，顺序即优先级 P1 / P2 / P3。',
        '选择 Mode、Burst Interval、Pay 后，配置写入 lib/settings/fire.ts。',
      ],
    },
    {
      phase: 'Strike',
      title: '发射阶段',
      items: [
        '读取有效 tickets 和优先级列表。',
        'buildStrikeQueue() 按优先级生成射击队列：1 个目标全给 P1；2 个目标按 P1, P1, P2, P1, P2…；3 个目标按 P1, P1, P2, P1, P3…。',
        '把最新录入的 ticket 排在 shotIdx=0，确保首枪质量最高。',
        '立即把这些 ticket 从票池扣除，防止重复发射。',
        '按 burstIntervalMs 顺序单线程调用 /api/biz/pay/preview；连续 555 时自动 +200ms 退避，连续 soldout ≥3 时提前停止。',
        '任意一枪返回 code=200 + bizId 时立即停止剩余 shot，并进入 Commit。',
        '全部打光都没拿到 bizId，发送 BURST_FIRE_DEPLETED，UI 显示 depleted。',
      ],
    },
    {
      phase: 'Commit',
      title: '锁单 + 支付阶段',
      items: [
        '调用 /api/biz/pay/create-sign，参数包括 productId / bizId / payType。',
        '成功后通过 OPEN_PAYMENT_TAB 消息让 background.ts 用 chrome.tabs.create 打开支付链接，避免 popup blocker。',
        '同时启动 pollPayCheck()，1.5s 间隔轮询 /api/biz/pay/check?bizId=，最多 5 分钟。',
        '根据结果发送 STRIKE_PAYMENT_SUCCESS / EXPIRED / TIMEOUT，UI 和 Fire Matrix 同步更新。',
      ],
    },
  ];
</script>

<div class="page-stack">
  <section class="section-card">
    <div class="section-heading">
      <span class="accent-bar" style="background: linear-gradient(180deg, var(--violet), var(--primary)); box-shadow: 0 0 14px rgba(99,102,241,0.35);"></span>
      <h3>使用说明</h3>
    </div>
    <p class="section-note">Fire 面板三控件（Mode / Burst Interval / Pay）的含义，以及 Preload → Strike → Commit 的完整链路。</p>

    <div class="usage-panel">
      <!-- Mode -->
      <div class="doc-hero">
        <span class="doc-badge">PART A</span>
        <h4>Mode：决定“什么时候发射”</h4>
        <p>底层：07-auto-fire.js 收到 FIRE_CONFIG 后，若 mode === 'manual' 会清空定时器并显示 Manual mode — auto disabled。</p>
      </div>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr><th>Mode</th><th>含义</th><th>行为</th></tr>
          </thead>
          <tbody>
            {#each MODE_ROWS as row}
              <tr><td class="u-name">{row.name}</td><td class="u-meaning">{row.meaning}</td><td class="u-desc">{row.behavior}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- Burst Interval -->
      <div class="doc-hero doc-hero-secondary">
        <span class="doc-badge">PART B</span>
        <h4>Burst Interval：决定“每枪间隔多久”</h4>
        <p>智谱后端使用 2 秒滑动窗口限流（阈值=1）。2100ms 是实测单用户最优：比窗口大 100ms 的安全余量，0% 触发 555。</p>
      </div>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr><th>间隔</th><th>含义</th><th>适用场景</th></tr>
          </thead>
          <tbody>
            <tr><td class="u-name">2100ms</td><td class="u-meaning">推荐默认</td><td class="u-desc">0% 555，单用户理论最优附近。</td></tr>
            <tr><td class="u-name">≥2300ms</td><td class="u-meaning">保守</td><td class="u-desc">网络抖动大或 RTT 超过 250ms 时使用，进一步降低 555 概率。</td></tr>
            <tr><td class="u-name">&lt;2000ms</td><td class="u-meaning">不推荐</td><td class="u-desc">会稳定触发 555，浪费 ticket。</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Flow -->
      <div class="doc-hero">
        <span class="doc-badge">PART C</span>
        <h4>整个 Fire 模块怎么工作</h4>
        <p>概括为三段式：Preload → Strike → Commit。</p>
      </div>
      <div class="flow-list">
        {#each FLOW as step}
          <article class="flow-card">
            <div class="flow-phase">{step.phase}</div>
            <div class="flow-content">
              <h5>{step.title}</h5>
              <ul>
                {#each step.items as item}
                  <li>{item}</li>
                {/each}
              </ul>
            </div>
          </article>
        {/each}
      </div>

      <!-- UI fields -->
      <div class="doc-hero">
        <span class="doc-badge">PART E</span>
        <h4>UI 各字段含义</h4>
        <p>Fire operations zone 中每个数字、按钮、状态分别代表什么。</p>
      </div>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr><th style="width:140px">字段</th><th>说明</th></tr>
          </thead>
          <tbody>
            {#each FIELD_ROWS as row}
              <tr><td class="u-name">{row.field}</td><td class="u-desc">{row.desc}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- Error codes -->
      <div class="doc-hero doc-hero-secondary">
        <span class="doc-badge">PART F</span>
        <h4>Fire Matrix 结果与责任主体</h4>
        <p>每个结果都标明【责任主体 --> 被调用方：原因】，方便你判断是插件问题、网络问题，还是智谱/腾讯侧服务繁忙。</p>
      </div>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr><th>结果</th><th>HTTP/code</th><th>责任链路</th><th>说明</th></tr>
          </thead>
          <tbody>
            {#each ERROR_ROWS as row}
              <tr>
                <td class="u-name">{row.outcome}</td>
                <td class="u-meaning">{row.code}</td>
                <td class="u-desc">【{row.subject} --> {row.target}：{row.cause}】</td>
                <td class="u-desc">{row.note}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="usage-summary">
        <strong>一句话总结：</strong>Mode 管“何时发”，Burst Interval 管“每枪隔多久”，Pay 决定支付方式。拿到第一个 bizId 后自动 create-sign 开支付页并轮询支付状态。
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

  .usage-panel { display: flex; flex-direction: column; gap: 20px; position: relative; z-index: 1; }

  .doc-hero { padding: 22px 24px; border-radius: 22px; border: 1px solid rgba(99,102,241,0.18); background: linear-gradient(135deg, rgba(99,102,241,0.12), rgba(16,185,129,0.08)); }
  .doc-hero-secondary { border-color: rgba(16,185,129,0.18); background: linear-gradient(135deg, rgba(16,185,129,0.12), rgba(14,165,233,0.08)); }
  .doc-badge { display: inline-flex; align-self: flex-start; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.58); border: 1px solid rgba(255,255,255,0.72); color: var(--violet); font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
  .doc-hero h4 { margin: 10px 0 8px; font-size: 1.35rem; font-weight: 800; color: var(--text-strong); letter-spacing: -0.03em; }
  .doc-hero p { margin: 0; color: var(--text-main); font-size: 14px; line-height: 1.7; }

  .usage-table-wrap { overflow-x: auto; border-radius: 18px; border: 1px solid var(--panel-border-soft); background: rgba(255,255,255,0.35); }
  @media (prefers-color-scheme: dark) { .usage-table-wrap { background: rgba(15,23,42,0.35); } }
  .usage-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .usage-table th { text-align: left; padding: 12px 16px; font-weight: 800; color: var(--text-strong); background: rgba(255,255,255,0.25); border-bottom: 1px solid var(--panel-border-soft); }
  @media (prefers-color-scheme: dark) { .usage-table th { background: rgba(15,23,42,0.25); } }
  .usage-table td { padding: 12px 16px; border-bottom: 1px solid rgba(188,200,214,0.12); vertical-align: top; line-height: 1.6; color: var(--text-main); }
  .usage-table tr:last-child td { border-bottom: 0; }
  .u-name { font-weight: 800; color: var(--text-strong); white-space: nowrap; font-family: 'SF Mono', monospace; font-size: 12px; }
  .u-meaning { font-weight: 700; color: var(--violet); white-space: nowrap; }
  .u-desc { color: var(--text-muted); }

  .flow-list { display: flex; flex-direction: column; gap: 14px; }
  .flow-card { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 16px; padding: 18px 20px; border-radius: 20px; border: 1px solid var(--panel-border-soft); background: rgba(255,255,255,0.4); box-shadow: 0 12px 28px rgba(118,136,158,0.1); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
  @media (prefers-color-scheme: dark) { .flow-card { background: rgba(15,23,42,0.42); } }
  .flow-phase { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 8px 12px; border-radius: 14px; background: linear-gradient(135deg, rgba(99,102,241,0.16), rgba(14,165,233,0.12)); color: var(--violet); font-size: 12px; font-weight: 800; letter-spacing: 0.12em; }
  .flow-content { display: flex; flex-direction: column; gap: 10px; }
  .flow-content h5 { margin: 0; color: var(--text-strong); font-weight: 800; letter-spacing: -0.02em; font-size: 1rem; }
  .flow-content ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; color: var(--text-muted); font-size: 13px; line-height: 1.7; }

  .usage-summary { padding: 18px 20px; border-radius: 18px; border: 1px solid rgba(16,185,129,0.2); background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(99,102,241,0.06)); color: var(--text-main); font-size: 14px; line-height: 1.7; }
  .usage-summary strong { color: var(--text-strong); }

  @media (max-width: 960px) {
    .flow-card { grid-template-columns: 1fr; }
    .flow-phase { justify-self: start; min-width: 92px; }
  }
</style>
