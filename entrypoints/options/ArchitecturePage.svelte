<script lang="ts">
  /* ── §01 数据 ── */
  const R = [
    { id: 'R1', feature: '系统通知倒计时提醒（60/30/15/5 分钟前触发）', carrier: 'Background SW', color: '#f59e0b' },
    { id: 'R2', feature: '验证码预取（Tencent CAPTCHA ticket 池）', carrier: 'bm-capture + bm-main', color: '#8b5cf6' },
    { id: 'R3', feature: 'bigmodel.cn 标签页内视觉 + 音频提醒', carrier: 'bm-capture', color: '#06b6d4' },
    { id: 'R4', feature: '扩展图标角标倒计时', carrier: 'Background SW', color: '#f59e0b' },
    { id: 'DEV', feature: 'API 调试面板（直接调用 bigmodel API）', carrier: 'Popup DEV', color: '#10b981' },
    { id: 'PROD', feature: '抢购操作面板（一键开火、支付轮询）', carrier: 'Popup PROD', color: '#ef4444' },
  ];

  /* ── §03 Entrypoints ── */
  const ENTRYPOINTS = [
    { icon: '⚙️', file: 'background.ts', title: '后台 Service Worker', role: 'SW', detail: 'R1（system notifications）+ R4（badge）。alarms.onAlarm 必须顶层注册。', bullets: ['读取 saleTimeConfig 计算下次秒杀', '调度 60/30/15/5 提醒并同步 badge', '浏览器关闭后靠 chrome.alarms 恢复'] },
    { icon: '🔒', file: 'bm-capture.content.ts', title: 'Content Script (ISOLATED)', role: 'ISOLATED', detail: '负责 R2、R3 与 Auth 捕获，通过 postMessage 与 bm-main 互通。', bullets: ['接收 MAIN world 的 ticket / UI 事件', '写入 storage + 批量 fetch', 'sale time 自动开火调度'] },
    { icon: '🚀', file: 'popup/', title: 'Popup DEV / PROD', role: 'POPUP', detail: 'Svelte 5 应用，DEV 调试 / PROD 秒杀。', bullets: ['Topbar 切换运行模式', 'DevContent API 卡片测试', 'ProdContent 开火 + 支付轮询'] },
    { icon: '📖', file: 'options/', title: '选项页 + 文档', role: 'OPTIONS', detail: 'saleTimeConfig 配置 + README 架构说明。', bullets: ['时间 / 时区 / 提醒校正', '验证码批量录入限制', '工作原理 + 软件架构文档'] },
  ];

  /* ── §05 Auth ── */
  const AUTH_STEPS = [
    { label: 'captureFromTab()', desc: '在 MAIN world 调用 extractAuthFromPage()' },
    { label: 'document.cookie', desc: '读取 JWT (authorization header)' },
    { label: 'localStorage', desc: '读取 bigmodelOrganization + bigmodelProject' },
    { label: 'local:authHeaders', desc: '写回 storage，popup 打开时刷新' },
  ];
  /* ── §06 Ticket ── */
  const TICKET_ACQ = [
    { label: 'Tencent CAPTCHA', desc: '拦截成功响应 → ticket + randstr' },
    { label: 'postMessage', desc: 'MAIN world → ISOLATED world' },
    { label: 'page sessionStorage', desc: 'bm-capture 写入 __bm_tickets' },
  ];
  const TICKET_USE = [
    { label: 'read pool', desc: 'bm-capture 读取 page sessionStorage 中的 tickets' },
    { label: 'build plan', desc: 'buildStrikeQueue 按优先级分配' },
    { label: 'fire', desc: '顺序单线程 /api/biz/pay/preview 请求' },
  ];

  /* ── §07 Storage ── */
  const STORAGE = [
    { key: 'local:authHeaders', type: 'AuthHeaders', writers: ['bm-capture', 'authStore'], readers: ['popup', 'bm-capture'] },
    { key: 'page sessionStorage (__bm_tickets)', type: 'Ticket[]', writers: ['bm-capture'], readers: ['bm-capture'] },
    { key: 'local:saleTimeConfig', type: 'SaleTimeConfig', writers: ['options'], readers: ['background', 'bm-capture'] },
    { key: 'local:devMode', type: 'dev | prod', writers: ['popup'], readers: ['popup'] },
    { key: 'local:selectedProducts', type: 'priorityList[]', writers: ['bm-main'], readers: ['bm-capture'] },
  ];
  const STORAGE_ACTORS = ['bm-capture', 'bm-main', 'popup', 'background', 'options', 'authStore'];

  /* ── §04 代理步骤 ── */
  const PROXY_STEPS = [
    { num: 1, title: '定位 Tab', desc: '找到已打开的 bigmodel.cn 标签页', icon: '🔍' },
    { num: 2, title: '注入脚本', desc: 'executeScript → MAIN world', icon: '💉' },
    { num: 3, title: '同源请求', desc: '以 bigmodel.cn 身份 fetch', icon: '🌐' },
    { num: 4, title: '返回结果', desc: 'results[0].result → bodyText', icon: '✅' },
  ];

  /* ── §08 bm-main ── */
  const CAPABILITIES = ['拦截 XMLHttpRequest（prototype 覆盖）', '访问页面 JS 运行时与全局状态', '读写 document.cookie 与 localStorage', 'window.postMessage → ISOLATED world'];
  const BM_MAINFUNCS = ['捕获 batch-preview 商品列表', '捕获 Tencent CAPTCHA ticket', '渲染抢购覆盖层 UI', '覆盖层事件 → bm-capture'];

  /* ── §09 决策 ── */
  const DECISIONS = [
    { id: 'D1', title: 'MAIN world + executeScript', detail: 'background / ISOLATED fetch 暴露 chrome-extension:// origin → 空 body。只有 MAIN world 能保住同源身份。', accent: '#f59e0b' },
    { id: 'D2', title: 'bm-main.js 是静态文件', detail: '复杂 UI + XHR 拦截不适合 executeScript 字面量。静态脚本注入后自由使用 DOM API。', accent: '#8b5cf6' },
    { id: 'D3', title: 'Ticket 池必须带 TTL', detail: 'CAPTCHA ticket ~5 分钟失效。TTL 自动清理保证池中只留有效弹药。', accent: '#ef4444' },
    { id: 'D4', title: 'Auth 每次打开 popup 刷新', detail: 'JWT / org / project 可能变化。主动 capture 避免过期认证。', accent: '#06b6d4' },
  ];

  const AUTH_SHAPE = `interface AuthHeaders {\n  authorization: string;\n  bigmodelOrganization: string;\n  bigmodelProject: string;\n}`;
  const TICKET_SHAPE = `interface Ticket {\n  ticket: string;\n  randstr: string;\n  createdAt: number;\n}`;
  const DIR_TREE = `/entrypoints/
├── background.ts          # Service worker
├── bm-capture.content.ts  # Content script (ISOLATED)
├── popup/                 # Svelte 5 popup
└── options/               # Svelte 5 选项页 + 文档
/lib/api/
├── client.ts · auth-store.ts
├── fire-plan.ts · types.ts
└── catalog.ts
/public/bm-main.js         # MAIN world 注入
/output/chrome-mv3/         # 构建输出`;
</script>

<div class="page-stack">
  <section class="section-card">
    <div class="section-heading">
      <span class="accent-bar" style="background:linear-gradient(180deg,var(--violet),var(--primary));box-shadow:0 0 14px rgba(99,102,241,0.35)"></span>
      <h3>软件架构</h3>
    </div>
    <p class="section-note">architecture.md 的网页版摘要。整体架构、入口点、同源代理、auth 与 ticket 系统。</p>

    <div class="arch-panel">
      <!-- ═══ HERO ═══ -->
      <div class="hero">
        <span class="badge">ARCHITECTURE</span>
        <h4>抢购助手 — 代码库架构与基本原理</h4>
        <p>构建工具 WXT 0.20.26 · Vite · TypeScript · Svelte 5 · Chrome MV3</p>
        <div class="pills">
          <span class="pill">WXT 0.20.26</span>
          <span class="pill">Vite</span>
          <span class="pill">TypeScript</span>
          <span class="pill">Svelte 5</span>
          <span class="pill">Chrome MV3</span>
        </div>
      </div>

      <!-- ═══ §01 产品目标 ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">01</span><div><h5>产品目标</h5><p>让用户在秒杀开始前做好准备，并在秒杀瞬间以最快速度完成下单。</p></div></div>
        <div class="req-grid">
          {#each R as r}
            <div class="req-card" style="--req-c:{r.color}">
              <div class="req-id" style="background:{r.color}20;color:{r.color}">{r.id}</div>
              <div class="req-body">
                <div class="req-feat">{r.feature}</div>
                <div class="req-carrier">{r.carrier}</div>
              </div>
            </div>
          {/each}
        </div>
      </section>

      <!-- ═══ §02 整体架构 — 盒图 ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">02</span><div><h5>整体架构</h5><p>Chrome Extension MV3 内部四大组件 + 共享 storage 构成完整秒杀链路。</p></div></div>
        <div class="arch-box-diagram">
          <!-- Background -->
          <div class="ab-component ab-bg">
            <div class="ab-icon">⚙️</div>
            <div class="ab-title">Background Service Worker</div>
            <div class="ab-desc">alarms · notifications · badge</div>
            <div class="ab-tags"><span class="ab-tag ab-tag-amber">R1</span><span class="ab-tag ab-tag-amber">R4</span></div>
          </div>
          <!-- Bigmodel Tab -->
          <div class="ab-component ab-tab">
            <div class="ab-tab-header">
              <div class="ab-icon">🌐</div>
              <div class="ab-title">bigmodel.cn Tab</div>
            </div>
            <div class="ab-dual-world">
              <div class="ab-world ab-isolated">
                <div class="ab-world-label">ISOLATED</div>
                <div class="ab-world-name">bm-capture</div>
                <div class="ab-world-desc">Content Script</div>
                <div class="ab-tags"><span class="ab-tag ab-tag-cyan">R2</span><span class="ab-tag ab-tag-cyan">R3</span></div>
              </div>
              <div class="ab-arrows-h">
                <span class="ab-arrow-left">postMessage →</span>
                <span class="ab-arrow-right">← postMessage</span>
              </div>
              <div class="ab-world ab-main">
                <div class="ab-world-label">MAIN world</div>
                <div class="ab-world-name">bm-main.js</div>
                <div class="ab-world-desc">静态注入脚本</div>
                <div class="ab-tags"><span class="ab-tag ab-tag-violet">覆盖层</span><span class="ab-tag ab-tag-violet">XHR</span></div>
              </div>
            </div>
          </div>
          <!-- Popup -->
          <div class="ab-component ab-popup">
            <div class="ab-icon">🚀</div>
            <div class="ab-title">Popup DEV / PROD</div>
            <div class="ab-desc">Svelte 5 · 双模式</div>
            <div class="ab-tags"><span class="ab-tag ab-tag-green">DEV</span><span class="ab-tag ab-tag-red">PROD</span></div>
          </div>
          <!-- Storage Bus -->
          <div class="ab-storage-bus">
            <div class="ab-bus-icon">📦</div>
            <div class="ab-bus-title">chrome.storage.local</div>
            <div class="ab-bus-keys">
              <span>authHeaders</span><span>ticketPool</span><span>saleTimeConfig</span><span>devMode</span><span>selectedProducts</span>
            </div>
          </div>
          <!-- Arrows to bus -->
          <div class="ab-bus-arrow ab-bus-arrow-bg">↓ rw</div>
          <div class="ab-bus-arrow ab-bus-arrow-tab">↕ rw</div>
          <div class="ab-bus-arrow ab-bus-arrow-pop">↓ rw</div>
        </div>
      </section>

      <!-- ═══ §03 Entrypoints ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">03</span><div><h5>Entrypoints（入口点）</h5><p>WXT 将 entrypoints 目录中每个入口分别打包；独立运行，通过 storage 和消息桥接协作。</p></div></div>
        <div class="entry-grid">
          {#each ENTRYPOINTS as e}
            <article class="entry-card">
              <div class="entry-top">
                <span class="entry-icon">{e.icon}</span>
                <span class="entry-role entry-role-{e.role.toLowerCase()}">{e.role}</span>
              </div>
              <div class="entry-file">{e.file}</div>
              <h6>{e.title}</h6>
              <p>{e.detail}</p>
              <ul>{#each e.bullets as b}<li>{b}</li>{/each}</ul>
            </article>
          {/each}
        </div>
      </section>

      <!-- ═══ §04 同源代理 — 流程图 ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">04</span><div><h5>核心机制：同源请求代理</h5><p>bigmodel.cn 拒绝 chrome-extension:// origin → 必须把 fetch 注入页面 MAIN world。</p></div></div>
        <div class="flow-strip">
          {#each PROXY_STEPS as s, i}
            <div class="flow-step">
              <div class="flow-num" style="background:{['#f59e0b','#8b5cf6','#10b981','#06b6d4'][i]}20;color:{['#f59e0b','#8b5cf6','#10b981','#06b6d4'][i]}">{s.num}</div>
              <div class="flow-icon">{s.icon}</div>
              <div class="flow-title">{s.title}</div>
              <div class="flow-desc">{s.desc}</div>
            </div>
            {#if i < PROXY_STEPS.length - 1}
              <div class="flow-arrow">→</div>
            {/if}
          {/each}
        </div>
        <div class="flow-note">
          <span class="flow-note-badge">权限</span>
          <code>permissions: scripting, tabs</code>
          <code>host_permissions: *://*.bigmodel.cn/*</code>
        </div>
      </section>

      <!-- ═══ §05 Auth + Ticket ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">05</span><div><h5>Auth 系统与 Ticket 系统</h5><p>Auth 保证 API 请求上下文有效；Ticket 池把 300 秒内有效的验证码凭证转成可发射弹药。</p></div></div>
        <div class="dual-panel">
          <!-- Auth -->
          <div class="panel-card">
            <div class="panel-header panel-header-amber">
              <span class="panel-icon">🔑</span>
              <div>
                <h6>Auth 认证链</h6>
                <pre class="mini-code">{AUTH_SHAPE}</pre>
              </div>
            </div>
            <div class="chain">
              {#each AUTH_STEPS as s, i}
                <div class="chain-node">
                  <div class="chain-label">{s.label}</div>
                  <div class="chain-desc">{s.desc}</div>
                </div>
                {#if i < AUTH_STEPS.length - 1}<div class="chain-arrow">↓</div>{/if}
              {/each}
            </div>
          </div>
          <!-- Ticket -->
          <div class="panel-card">
            <div class="panel-header panel-header-violet">
              <span class="panel-icon">🎫</span>
              <div>
                <h6>Ticket 生命周期</h6>
                <pre class="mini-code">{TICKET_SHAPE}</pre>
              </div>
            </div>
            <div class="ticket-flows">
              <div class="tf-label">获取 Acquisition</div>
              <div class="chain">
                {#each TICKET_ACQ as s, i}
                  <div class="chain-node">
                    <div class="chain-label">{s.label}</div>
                    <div class="chain-desc">{s.desc}</div>
                  </div>
                  {#if i < TICKET_ACQ.length - 1}<div class="chain-arrow">↓</div>{/if}
                {/each}
              </div>
              <div class="tf-divider"></div>
              <div class="tf-label">使用 Usage / Fire</div>
              <div class="chain">
                {#each TICKET_USE as s, i}
                  <div class="chain-node">
                    <div class="chain-label">{s.label}</div>
                    <div class="chain-desc">{s.desc}</div>
                  </div>
                  {#if i < TICKET_USE.length - 1}<div class="chain-arrow">↓</div>{/if}
                {/each}
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ═══ §06 Storage 矩阵 ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">06</span><div><h5>Storage 架构</h5><p>所有入口通过 chrome.storage.local 共享状态。矩阵展示每个 key 的写入者与读取者。</p></div></div>
        <div class="storage-matrix">
          <div class="sm-header">
            <div class="sm-cell sm-key">WXT Key</div>
            <div class="sm-cell sm-type">类型</div>
            {#each STORAGE_ACTORS as a}
              <div class="sm-cell sm-actor">{a}</div>
            {/each}
          </div>
          {#each STORAGE as row}
            <div class="sm-row">
              <div class="sm-cell sm-key"><code>{row.key}</code></div>
              <div class="sm-cell sm-type"><span class="sm-type-badge">{row.type}</span></div>
              {#each STORAGE_ACTORS as actor}
                <div class="sm-cell sm-dot-cell">
                  {#if row.writers.includes(actor)}
                    <span class="sm-dot sm-dot-w" title="Writer">W</span>
                  {/if}
                  {#if row.readers.includes(actor)}
                    <span class="sm-dot sm-dot-r" title="Reader">R</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/each}
        </div>
        <div class="sm-legend">
          <span class="sm-dot sm-dot-w">W</span> 写入者
          <span class="sm-dot sm-dot-r" style="margin-left:12px">R</span> 读取者
        </div>
      </section>

      <!-- ═══ §07 bm-main.js 注入 ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">07</span><div><h5>MAIN World 注入脚本（bm-main.js）</h5><p>作为 web_accessible_resources 注入 bigmodel.cn 页面，拥有页面级 JS 上下文能力。</p></div></div>
        <div class="injection-diagram">
          <div class="id-source">
            <div class="id-box id-box-ext">
              <div class="id-box-title">Extension</div>
              <div class="id-box-detail">bm-capture.content.ts</div>
            </div>
            <div class="id-arrow">→ <code>&lt;script&gt;</code> →</div>
            <div class="id-box id-box-page">
              <div class="id-box-title">bigmodel.cn Page</div>
              <div class="id-box-detail">bm-main.js (MAIN world)</div>
            </div>
          </div>
          <div class="id-caps-grid">
            <div class="id-cap-section">
              <div class="id-cap-head">MAIN world 能力</div>
              {#each CAPABILITIES as c}
                <div class="id-cap-item"><span class="id-cap-dot" style="background:#10b981"></span>{c}</div>
              {/each}
            </div>
            <div class="id-cap-section">
              <div class="id-cap-head">bm-main.js 功能</div>
              {#each BM_MAINFUNCS as f}
                <div class="id-cap-item"><span class="id-cap-dot" style="background:#8b5cf6"></span>{f}</div>
              {/each}
            </div>
          </div>
        </div>
      </section>

      <!-- ═══ §08 构建与开发 ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">08</span><div><h5>构建与开发</h5><p>围绕 WXT entrypoints 结构展开，构建输出落在 output/chrome-mv3。</p></div></div>
        <div class="build-panels">
          <div class="panel-card">
            <div class="panel-header panel-header-cyan">
              <span class="panel-icon">📁</span><h6>目录结构</h6>
            </div>
            <pre class="doc-code">{DIR_TREE}</pre>
          </div>
          <div class="panel-card">
            <div class="panel-header panel-header-green">
              <span class="panel-icon">⚡</span><h6>常用命令</h6>
            </div>
            <pre class="doc-code">npm run dev      # HMR 开发模式
npm run build    # 生产构建 → output/chrome-mv3/</pre>
          </div>
        </div>
      </section>

      <!-- ═══ §09 设计决策 ═══ -->
      <section class="sec">
        <div class="sec-head"><span class="sec-idx">09</span><div><h5>关键设计决策</h5><p>解释为什么采用 MAIN world 执行 + 静态注入 + TTL ticket 池 + popup 刷新 auth 的组合。</p></div></div>
        <div class="decisions-grid">
          {#each DECISIONS as d}
            <article class="dec-card" style="--dec-c:{d.accent}">
              <div class="dec-id" style="background:{d.accent}18;color:{d.accent}">{d.id}</div>
              <h6>{d.title}</h6>
              <p>{d.detail}</p>
            </article>
          {/each}
        </div>
      </section>

    </div>
  </section>
</div>

<style>
  /* ── 基础布局 ── */
  .page-stack{display:flex;flex-direction:column;gap:24px}
  .section-card{background:linear-gradient(135deg,rgba(255,255,255,.72),rgba(255,255,255,.24));border:1px solid var(--panel-border);border-top-color:rgba(255,255,255,.88);border-left-color:rgba(255,255,255,.88);box-shadow:var(--card-shadow);border-radius:var(--radius-xl);padding:28px 30px;position:relative;overflow:hidden;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
  @media(prefers-color-scheme:dark){.section-card{background:linear-gradient(135deg,rgba(30,41,59,.78),rgba(15,23,42,.52));border-top-color:rgba(255,255,255,.12);border-left-color:rgba(255,255,255,.12)}}
  .section-card::before{content:'';position:absolute;inset:-80px auto auto -80px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(16,185,129,.09),transparent 68%);pointer-events:none}
  .section-heading{display:flex;align-items:center;gap:12px;margin:0 0 8px;position:relative;z-index:1}
  .accent-bar{width:6px;height:26px;border-radius:999px;background:var(--primary);box-shadow:0 0 14px rgba(16,185,129,.35);flex:0 0 auto}
  .section-heading h3{margin:0;font-size:1.1rem;font-weight:800;color:var(--text-strong);letter-spacing:-.02em}
  .section-note{margin:0 0 24px 18px;color:var(--text-muted);font-size:13px;line-height:1.6;position:relative;z-index:1}

  /* ── 面板 ── */
  .arch-panel{display:flex;flex-direction:column;gap:20px;position:relative;z-index:1}
  .hero{padding:22px 24px;border-radius:22px;border:1px solid rgba(99,102,241,.18);background:linear-gradient(135deg,rgba(99,102,241,.12),rgba(16,185,129,.08));display:flex;flex-direction:column;gap:12px}
  .badge{align-self:flex-start;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.58);border:1px solid rgba(255,255,255,.72);color:var(--violet);font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
  .hero h4{margin:10px 0 8px;font-size:1.35rem;font-weight:800;color:var(--text-strong);letter-spacing:-.03em}
  .hero p{margin:0;color:var(--text-main);font-size:14px;line-height:1.7}
  .pills{display:flex;flex-wrap:wrap;gap:10px}
  .pill{padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.52);border:1px solid rgba(255,255,255,.82);color:var(--text-main);font-size:12px;font-weight:700}

  /* ── Section head ── */
  .sec{display:flex;flex-direction:column;gap:16px;padding:22px 0 4px;border-top:1px solid var(--line-soft)}
  .sec:first-of-type{border-top:0;padding-top:0}
  .sec-head{display:grid;grid-template-columns:52px minmax(0,1fr);gap:14px;align-items:start}
  .sec-idx{display:inline-grid;place-items:center;width:52px;height:52px;border-radius:18px;background:linear-gradient(135deg,rgba(99,102,241,.14),rgba(16,185,129,.12));color:var(--violet);font-size:14px;font-weight:900}
  .sec-head h5{margin:0;color:var(--text-strong);font-weight:800;letter-spacing:-.02em}
  .sec-head p{margin:0;color:var(--text-muted);font-size:13px;line-height:1.7}

  /* ══════════════════════════════════════
     §01 需求卡片
     ══════════════════════════════════════ */
  .req-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .req-card{display:flex;gap:12px;padding:14px 16px;border-radius:16px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.4);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  @media(prefers-color-scheme:dark){.req-card{background:rgba(15,23,42,.42)}}
  .req-id{flex:0 0 42px;display:inline-grid;place-items:center;border-radius:12px;font-size:12px;font-weight:900;align-self:start;margin-top:2px}
  .req-body{display:flex;flex-direction:column;gap:4px}
  .req-feat{font-size:13px;font-weight:600;color:var(--text-main);line-height:1.5}
  .req-carrier{font-size:11px;color:var(--text-muted);font-weight:600}

  /* ══════════════════════════════════════
     §02 整体架构盒图
     ══════════════════════════════════════ */
  .arch-box-diagram{display:grid;grid-template-columns:220px 1fr 180px;grid-template-rows:auto auto 60px;gap:12px;padding:20px}
  .ab-component{padding:16px 18px;border-radius:18px;border:2px solid var(--panel-border-soft);background:rgba(255,255,255,.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
  @media(prefers-color-scheme:dark){.ab-component{background:rgba(15,23,42,.45)}}
  .ab-icon{font-size:20px;margin-bottom:6px}
  .ab-title{font-size:13px;font-weight:800;color:var(--text-strong);letter-spacing:-.02em}
  .ab-desc{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.5}
  .ab-tags{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
  .ab-tag{padding:3px 8px;border-radius:999px;font-size:10px;font-weight:800}
  .ab-tag-amber{background:#f59e0b18;color:#f59e0b}
  .ab-tag-cyan{background:#06b6d418;color:#06b6d4}
  .ab-tag-violet{background:#8b5cf618;color:#8b5cf6}
  .ab-tag-green{background:#10b98118;color:#10b981}
  .ab-tag-red{background:#ef444418;color:#ef4444}

  .ab-bg{grid-column:1;grid-row:1;border-color:#f59e0b30}
  .ab-popup{grid-column:1;grid-row:2;border-color:#10b98130}
  .ab-tab{grid-column:2;grid-row:1/3;border-color:#8b5cf630}
  .ab-tab-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .ab-dual-world{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:stretch}
  .ab-world{padding:14px;border-radius:14px;border:1.5px dashed var(--panel-border-soft);background:rgba(255,255,255,.3)}
  @media(prefers-color-scheme:dark){.ab-world{background:rgba(15,23,42,.3)}}
  .ab-world-label{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px}
  .ab-isolated .ab-world-label{color:#06b6d4}
  .ab-main .ab-world-label{color:#8b5cf6}
  .ab-world-name{font-size:13px;font-weight:800;color:var(--text-strong)}
  .ab-world-desc{font-size:11px;color:var(--text-muted);margin-top:2px}
  .ab-arrows-h{display:flex;flex-direction:column;justify-content:center;gap:4px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap}

  .ab-storage-bus{grid-column:1/4;grid-row:3;display:flex;align-items:center;gap:12px;padding:12px 18px;border-radius:14px;border:2px solid rgba(16,185,129,.25);background:linear-gradient(90deg,rgba(16,185,129,.08),rgba(99,102,241,.06))}
  .ab-bus-icon{font-size:20px}
  .ab-bus-title{font-size:14px;font-weight:800;color:var(--text-strong);white-space:nowrap}
  .ab-bus-keys{display:flex;flex-wrap:wrap;gap:8px}
  .ab-bus-keys span{padding:4px 10px;border-radius:999px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:var(--text-main);font-size:11px;font-weight:700;font-family:'SF Mono',monospace}

  .ab-bus-arrow{display:none;/* hidden on mobile, visible on desktop via grid */font-size:11px;font-weight:700;color:var(--primary);text-align:center}

  @media(max-width:860px){
    .arch-box-diagram{grid-template-columns:1fr;grid-template-rows:auto}
    .ab-bg,.ab-popup,.ab-tab,.ab-storage-bus{grid-column:1;grid-row:auto}
    .ab-dual-world{grid-template-columns:1fr;gap:8px}
    .ab-arrows-h{flex-direction:row;justify-content:center}
  }

  /* ══════════════════════════════════════
     §03 Entrypoints 卡片
     ══════════════════════════════════════ */
  .entry-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .entry-card{padding:18px 20px;border-radius:18px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.4);box-shadow:0 8px 24px rgba(118,136,158,.08);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
  @media(prefers-color-scheme:dark){.entry-card{background:rgba(15,23,42,.42)}}
  .entry-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .entry-icon{font-size:22px}
  .entry-role{padding:4px 10px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.08em}
  .entry-role-sw{background:#f59e0b18;color:#f59e0b}
  .entry-role-isolated{background:#06b6d418;color:#06b6d4}
  .entry-role-popup{background:#10b98118;color:#10b981}
  .entry-role-options{background:#8b5cf618;color:#8b5cf6}
  .entry-file{font-size:11px;font-family:'SF Mono',monospace;color:var(--text-muted);margin-bottom:6px}
  .entry-card h6{margin:0;font-size:14px;font-weight:800;color:var(--text-strong)}
  .entry-card p{margin:6px 0 0;font-size:12px;color:var(--text-muted);line-height:1.6}
  .entry-card ul{display:flex;flex-direction:column;gap:4px;margin:10px 0 0;padding-left:16px;font-size:12px;color:var(--text-main);line-height:1.6}
  .entry-card li{margin:0}

  /* ══════════════════════════════════════
     §04 流程图
     ══════════════════════════════════════ */
  .flow-strip{display:flex;align-items:stretch;gap:0;padding:16px;border-radius:18px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.35);overflow-x:auto}
  @media(prefers-color-scheme:dark){.flow-strip{background:rgba(15,23,42,.35)}}
  .flow-step{flex:1;min-width:120px;display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 10px;text-align:center}
  .flow-num{width:32px;height:32px;display:inline-grid;place-items:center;border-radius:10px;font-size:13px;font-weight:900}
  .flow-icon{font-size:20px}
  .flow-title{font-size:13px;font-weight:800;color:var(--text-strong)}
  .flow-desc{font-size:11px;color:var(--text-muted);line-height:1.5}
  .flow-arrow{display:flex;align-items:center;font-size:22px;color:var(--text-muted);font-weight:800;padding:0 4px;flex:0 0 auto}
  .flow-note{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
  .flow-note-badge{padding:4px 10px;border-radius:999px;background:rgba(239,68,68,.1);color:#ef4444;font-size:11px;font-weight:800}
  .flow-note code{font-family:'SF Mono',monospace;font-size:11px;padding:4px 8px;border-radius:8px;background:rgba(15,23,42,.08);color:var(--text-main)}

  /* ══════════════════════════════════════
     §05 Auth + Ticket 双面板
     ══════════════════════════════════════ */
  .dual-panel{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .panel-card{padding:18px;border-radius:18px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.4);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;flex-direction:column;gap:16px}
  @media(prefers-color-scheme:dark){.panel-card{background:rgba(15,23,42,.42)}}
  .panel-header{display:flex;align-items:flex-start;gap:12px;padding:14px;border-radius:14px}
  .panel-header h6{margin:0;font-size:14px;font-weight:800;color:var(--text-strong)}
  .panel-header-amber{background:#f59e0b0a;border:1px solid #f59e0b18}
  .panel-header-violet{background:#8b5cf60a;border:1px solid #8b5cf618}
  .panel-header-cyan{background:#06b6d40a;border:1px solid #06b6d418}
  .panel-header-green{background:#10b9810a;border:1px solid #10b98118}
  .panel-icon{font-size:20px;flex:0 0 auto;margin-top:2px}
  .mini-code{margin:8px 0 0;padding:10px 12px;border-radius:10px;background:rgba(15,23,42,.88);color:#dbeafe;font-size:11px;line-height:1.6;white-space:pre;font-family:'SF Mono',monospace}
  .chain{display:flex;flex-direction:column;gap:2px}
  .chain-node{padding:10px 14px;border-radius:12px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.35)}
  @media(prefers-color-scheme:dark){.chain-node{background:rgba(15,23,42,.35)}}
  .chain-label{font-size:12px;font-weight:800;color:var(--text-strong);font-family:'SF Mono',monospace}
  .chain-desc{font-size:11px;color:var(--text-muted);margin-top:2px;line-height:1.5}
  .chain-arrow{display:flex;justify-content:center;color:var(--text-muted);font-size:14px;font-weight:800;padding:2px 0}
  .ticket-flows{display:flex;flex-direction:column;gap:8px}
  .tf-label{font-size:11px;font-weight:800;color:var(--text-muted);letter-spacing:.06em;text-transform:uppercase;padding-left:4px}
  .tf-divider{height:1px;background:var(--line-soft);margin:4px 0}

  /* ══════════════════════════════════════
     §06 Storage 矩阵
     ══════════════════════════════════════ */
  .storage-matrix{overflow-x:auto;border-radius:18px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.35)}
  @media(prefers-color-scheme:dark){.storage-matrix{background:rgba(15,23,42,.35)}}
  .sm-header,.sm-row{display:grid;grid-template-columns:180px 100px repeat(6,minmax(60px,1fr));gap:0;align-items:center}
  .sm-header{border-bottom:2px solid var(--line-soft);background:rgba(255,255,255,.2)}
  @media(prefers-color-scheme:dark){.sm-header{background:rgba(15,23,42,.2)}}
  .sm-row{border-bottom:1px solid rgba(188,200,214,.12)}
  .sm-row:last-child{border-bottom:0}
  .sm-cell{padding:10px 12px;font-size:12px;line-height:1.5}
  .sm-key code{font-family:'SF Mono',monospace;font-size:11px;color:var(--text-strong);font-weight:700}
  .sm-type-badge{padding:3px 8px;border-radius:999px;background:rgba(139,92,246,.08);color:#8b5cf6;font-size:10px;font-weight:800;font-family:'SF Mono',monospace}
  .sm-actor{font-size:10px;font-weight:800;color:var(--text-muted);text-align:center;letter-spacing:.04em}
  .sm-dot-cell{display:flex;justify-content:center;gap:4px;min-height:32px;align-items:center}
  .sm-dot{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:8px;font-size:10px;font-weight:900}
  .sm-dot-w{background:rgba(16,185,129,.15);color:#10b981}
  .sm-dot-r{background:rgba(99,102,241,.15);color:#6366f1}
  .sm-legend{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;color:var(--text-muted);font-weight:700;padding-left:4px}
  @media(max-width:860px){.sm-header,.sm-row{grid-template-columns:140px 80px repeat(6,52px)}}

  /* ══════════════════════════════════════
     §07 注入图
     ══════════════════════════════════════ */
  .injection-diagram{display:flex;flex-direction:column;gap:16px}
  .id-source{display:flex;align-items:center;gap:12px;justify-content:center;padding:16px;border-radius:18px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.3);flex-wrap:wrap}
  @media(prefers-color-scheme:dark){.id-source{background:rgba(15,23,42,.3)}}
  .id-box{padding:14px 20px;border-radius:14px;border:2px solid;text-align:center}
  .id-box-ext{border-color:#f59e0b40;background:rgba(245,158,11,.06)}
  .id-box-page{border-color:#8b5cf640;background:rgba(139,92,246,.06)}
  .id-box-title{font-size:13px;font-weight:800;color:var(--text-strong)}
  .id-box-detail{font-size:11px;color:var(--text-muted);margin-top:2px;font-family:'SF Mono',monospace}
  .id-arrow{font-size:14px;font-weight:800;color:var(--text-muted)}
  .id-arrow code{font-size:12px;padding:2px 6px;border-radius:6px;background:rgba(15,23,42,.08)}
  .id-caps-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .id-cap-section{padding:16px;border-radius:16px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.35)}
  @media(prefers-color-scheme:dark){.id-cap-section{background:rgba(15,23,42,.35)}}
  .id-cap-head{font-size:12px;font-weight:800;color:var(--text-strong);margin-bottom:10px;letter-spacing:-.01em}
  .id-cap-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--text-main);line-height:1.5;margin-bottom:6px}
  .id-cap-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:4px}

  /* ══════════════════════════════════════
     §08 构建面板
     ══════════════════════════════════════ */
  .build-panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .doc-code{margin:0;padding:14px 16px;border-radius:14px;background:rgba(15,23,42,.88);color:#dbeafe;font-size:12px;line-height:1.7;overflow:auto;font-family:'SF Mono',monospace;white-space:pre}

  /* ══════════════════════════════════════
     §09 决策卡片
     ══════════════════════════════════════ */
  .decisions-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
  .dec-card{padding:18px 20px;border-radius:18px;border:1px solid var(--panel-border-soft);background:rgba(255,255,255,.4);box-shadow:0 8px 24px rgba(118,136,158,.08);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-left:3px solid var(--dec-c)}
  @media(prefers-color-scheme:dark){.dec-card{background:rgba(15,23,42,.42)}}
  .dec-id{display:inline-flex;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:900;margin-bottom:10px}
  .dec-card h6{margin:0;font-size:13px;font-weight:800;color:var(--text-strong);letter-spacing:-.02em}
  .dec-card p{margin:8px 0 0;font-size:12px;color:var(--text-muted);line-height:1.7}

  /* ══════════════════════════════════════
     响应式
     ══════════════════════════════════════ */
  @media(max-width:960px){
    .entry-grid,.dual-panel,.decisions-grid,.build-panels,.id-caps-grid{grid-template-columns:1fr}
  }
  @media(max-width:720px){
    .sec-head{grid-template-columns:1fr}
    .sec-idx{display:none}
    .req-grid{grid-template-columns:1fr}
  }
</style>
