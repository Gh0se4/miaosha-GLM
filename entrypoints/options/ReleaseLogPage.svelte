<script lang="ts">
  import { version } from '../../package.json';

  interface LogItem {
    category: 'feature' | 'improvement' | 'fix' | 'cleanup';
    title: string;
    body: string;
  }

  const CATEGORIES: Record<LogItem['category'], { label: string; color: string }> = {
    feature:     { label: '新增', color: '#10b981' },
    improvement: { label: '优化', color: '#6366f1' },
    fix:         { label: '修复', color: '#f59e0b' },
    cleanup:     { label: '清理', color: '#64748b' },
  };

  const LOGS: LogItem[] = [
    {
      category: 'feature',
      title: '火山引擎覆盖层登录态守卫与一键登录',
      body: '未登录时「开始刷新库存」按钮变为「请先登录」，点击后直接触发页面登录弹窗或跳转登录页；刷新过程中如果登录态失效会自动停止，避免无意义空转。',
    },
    {
      category: 'improvement',
      title: 'Wave 轮询模式',
      body: '火山引擎 Agent Plan / Coding Plan 的刷新逻辑从 setInterval 单商品轮询改为 Wave 模式：每一轮按选中顺序依次尝试所有商品，任意一个下单成功即停止并跳转支付；一轮结束后再等待间隔进入下一轮，避免请求重叠。',
    },
    {
      category: 'improvement',
      title: '默认刷新间隔调整为 0.5s',
      body: '火山引擎覆盖层的默认刷新间隔从 10s 下调至 0.5s，并保留 0.5s~10s 的可调范围，提升抢购响应速度。',
    },
    {
      category: 'fix',
      title: 'calculatePriceV5 网络失败重试与日志降噪',
      body: '火山引擎动态定价接口偶发 TypeError: Failed to fetch 时，现在会自动进行最多 3 次指数退避重试；重试日志降级为 console.debug，最终失败以字符串警告输出，避免 transient 网络抖动被 Chrome 扩展 Errors 页误报为插件错误。',
    },
    {
      category: 'improvement',
      title: '全局版本标识统一为 v1.4.2',
      body: 'package.json、README、Options 页、智谱浮层、Fire Matrix 与火山引擎浮层的版本号全部同步为 v1.4.2。',
    },
    {
      category: 'feature',
      title: '火山引擎双活动垂直切片',
      body: 'Agent Plan 与 Coding Plan 完全拆分为独立的 MAIN-world 覆盖层、content script、平台适配器与订单流水线。每个活动维护自己的 bundle 解析、动态定价与下单逻辑，互不干扰，方便后续活动快速复制。',
    },
    {
      category: 'feature',
      title: '动态定价与订单索引自愈',
      body: '价格不再写死，改为实时调用 /api/sales/calculatePriceV5 获取原价与折扣价。解析 bundle 时收集同一 (ConfigurationCode, Duration) 的所有候选 IndexKey，遇到 InvalidParameter.Configuration 自动重试下一个索引，规避火山引擎侧配置不一致导致的误失败。',
    },
    {
      category: 'improvement',
      title: '火山引擎覆盖层改为月/季/年标签页',
      body: '火山引擎浮层从全展开列表改为「月付 / 季付 / 年付」三个标签页，与智谱覆盖层体验保持一致，减少用户滚动与选择负担。',
    },
    {
      category: 'fix',
      title: 'OK badge 生命周期',
      body: '购买成功后显示的 OK 角标现在会在 30 分钟后自动清除、用户打开 popup 时清除、以及重新调度秒杀提醒时清除，避免角标长期占用工具栏。',
    },
    {
      category: 'improvement',
      title: '全局版本标识统一为 v1.4.1',
      body: 'package.json、README、Options 页、Batch Mode 横幅、Fire Matrix、智谱浮层与火山引擎浮层的版本号全部同步为 v1.4.1；火山引擎浮层版本号由 content script 从 manifest 注入，解决 MAIN world 无法读取 chrome.runtime.getManifest 的问题。',
    },
    {
      category: 'improvement',
      title: 'Fire Matrix 调用链路与错误责任主体',
      body: 'Fire Matrix 底部新增可折叠的 /pay/preview 五步调用链路图，标出 401/500/555/sold-out/bizId 在链中的位置。将“验证码校验服务异常”等 raw serverMsg 翻译为【智谱 --> 腾讯验证码核销：超过了 QPS 限制】格式，明确责任主体与调用关系；新增“验证码繁忙/失效/风控”独立 outcome 与统计，避免用户误以为是插件 bug。',
    },
    {
      category: 'feature',
      title: 'BURST 并发轰炸模式',
      body: '新增固定 200ms 间隔的 BURST 并发发射按钮。与默认 Strike 串行模式并存：Strike 按 Strike Interval 顺序发射并自动 555 退避；BURST 忽略 555 退避、快速齐射，适合秒杀窗口内火力压制。',
    },
    {
      category: 'improvement',
      title: 'Batch Mode Active 横幅双按钮 + Wave 标识',
      body: 'Batch Mode 红色横幅新增 Fire 串行 / BURST 并发 两个发射按钮，并加入紫色 Wave N 计数徽章，方便在验证码收集过程中直接发起对应模式的发射。',
    },
    {
      category: 'improvement',
      title: 'Fire 面板标签与 tooltips 优化',
      body: '将 Burst Interval 重命名为 Strike Interval，明确其仅作用于串行模式；FIRE / BURST 按钮名称与 tooltip 分别标注“串行”与“并发”，降低用户选择负担。',
    },
    {
      category: 'improvement',
      title: '全局版本标识',
      body: '在 Batch Mode 横幅、Popup 顶部、页面浮层 Fire 面板、Fire Matrix 面板四个位置统一展示当前版本号，方便用户与截图反馈时确认版本。',
    },
    {
      category: 'feature',
      title: '全新 Fire 策略：错峰首枪 + 稳定连发 + 动态换弹',
      body: '基于实测结论重构发射调度器。新增首枪时间偏移、错峰抖动窗、商品优先级 ticket 配比、错误码驱动退避（500/555 分别处理）、动态目标切换与换弹重分配，提升在智谱 2 秒滑动窗口与腾讯 1000 QPS 核销上限下的命中概率。',
    },
    {
      category: 'feature',
      title: 'Fire Matrix 策略可视化',
      body: '实时展示当前 offset、stagger、allocation 配比、当前退避间隔，并在时间线中标注目标切换、退避调整与重分配事件，方便观察调度器决策过程。',
    },
    {
      category: 'feature',
      title: '商品优先级与 Ticket 配比',
      body: 'Target Products 最多可选 3 个并按 P1/P2/P3 排序；Fire Config 支持按优先级分配 ticket 比例（默认 70/20/10），动态切换时剩余 ticket 会自动在存活商品间重新分配。',
    },
    {
      category: 'improvement',
      title: 'Alarm 提醒增强',
      body: '新增 T-10 提醒；badge 从 T-60 起持续显示，直到被下一阶段图标替换；T-5/T-10/T-15/T-30/T-60 分别对应 4/3/1/1/1 声蜂鸣；Options 页面增加声音总开关，默认开启。',
    },
    {
      category: 'fix',
      title: '抢购默认时间显示修复',
      body: 'Options 中「重置默认」按钮现在正确显示 UTC+8 10:00:00.000，而不是被时区偏移成 18:00:00.000。',
    },
    {
      category: 'improvement',
      title: 'UI 信息分级重构',
      body: '将 overlay 信息拆分为基础信息（用户/时间/延迟）、配置区（商品与资源配比）与操作区（验证码收集与发射策略），降低认知负荷。',
    },
    {
      category: 'feature',
      title: 'Options 文档页',
      body: '新增使用说明、软件架构、关键洞察与本次更新日志四个文档页，帮助用户理解原理与最佳实践。',
    },
    {
      category: 'improvement',
      title: '首枪自动校准',
      body: 'Auto 模式根据实测 latency 计算发射时刻，并支持正负偏移与随机抖动，让第一枪尽量在秒杀瞬间到达业务层。',
    },
    {
      category: 'cleanup',
      title: '移除冗余模块与 Dev 配置',
      body: '删除已废弃的 payment-store、ticket-store、runtime-calibration、dev 配置项、batch-preview 轮询及大量调试脚本，减少包体积与维护面。',
    },
    {
      category: 'improvement',
      title: '测试覆盖',
      body: '新增 fire-plan、fire settings、background alarms 等单元测试，并在重构过程中持续更新测试期望，确保功能等价。',
    },
  ];

  const STATS = [
    { label: 'Commits since v1.0.0.alpha', value: '34+' },
    { label: '新增 Options 文档页', value: '4' },
    { label: 'Fire 策略配置项', value: '8' },
    { label: 'Alarm 阶段', value: '5' },
  ];
</script>

<div class="page-stack">
  <section class="section-card">
    <div class="section-heading">
      <span class="accent-bar" style="background: linear-gradient(180deg, var(--primary), var(--violet)); box-shadow: 0 0 14px rgba(16,185,129,0.35);"></span>
      <h3>v{version} 更新日志</h3>
    </div>
    <p class="section-note">
      自 <code>v1.0.0.alpha</code> 以来的主要改进。本次发布聚焦「策略精细化」与「体验可观测性」：从实测数据出发优化发射节奏，同时把配置、提醒与决策过程更直观地呈现给用户。
    </p>

    <div class="stats-row">
      {#each STATS as stat}
        <div class="stat-card">
          <span class="stat-value">{stat.value}</span>
          <span class="stat-label">{stat.label}</span>
        </div>
      {/each}
    </div>
  </section>

  <section class="section-card">
    <div class="section-heading">
      <span class="accent-bar" style="background: var(--amber); box-shadow: 0 0 14px rgba(245,158,11,0.35);"></span>
      <h3>变更详情</h3>
    </div>

    <ol class="log-list">
      {#each LOGS as log}
        <li class="log-item">
          <span class="log-badge" style="background: {CATEGORIES[log.category].color}20; color: {CATEGORIES[log.category].color}; border-color: {CATEGORIES[log.category].color}30;">
            {CATEGORIES[log.category].label}
          </span>
          <div class="log-content">
            <h4>{log.title}</h4>
            <p>{log.body}</p>
          </div>
        </li>
      {/each}
    </ol>
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

  .section-heading { display: flex; align-items: center; gap: 12px; margin: 0 0 8px; position: relative; z-index: 1; }
  .accent-bar { width: 6px; height: 26px; border-radius: 999px; background: var(--primary); box-shadow: 0 0 14px rgba(16,185,129,0.35); flex: 0 0 auto; }
  .section-heading h3 { margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--text-strong); letter-spacing: -0.02em; }
  .section-note { margin: 0 0 24px 18px; color: var(--text-muted); font-size: 13px; line-height: 1.6; position: relative; z-index: 1; }
  .section-note code {
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 6px;
    background: rgba(99,102,241,0.1);
    color: var(--violet);
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 14px;
    margin-top: 8px;
  }
  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px;
    border-radius: 16px;
    background: rgba(255,255,255,0.5);
    border: 1px solid var(--panel-border-soft);
  }
  @media (prefers-color-scheme: dark) {
    .stat-card { background: rgba(15,23,42,0.42); }
  }
  .stat-value { font-size: 26px; font-weight: 800; color: var(--primary-strong); }
  .stat-label { font-size: 11px; color: var(--text-muted); font-weight: 600; }

  .log-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .log-item {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 16px;
    border-radius: 16px;
    background: rgba(255,255,255,0.42);
    border: 1px solid var(--panel-border-soft);
  }
  @media (prefers-color-scheme: dark) {
    .log-item { background: rgba(15,23,42,0.32); }
  }
  .log-badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 800;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .log-content { display: flex; flex-direction: column; gap: 6px; }
  .log-content h4 { margin: 0; font-size: 14px; font-weight: 800; color: var(--text-strong); }
  .log-content p { margin: 0; font-size: 12px; line-height: 1.65; color: var(--text-muted); }
</style>
