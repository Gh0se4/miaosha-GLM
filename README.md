# 智谱秒杀助手

> **智谱 Coding Plan 秒杀助手** — Chrome MV3 浏览器扩展，辅助抢购 bigmodel.cn 限量套餐。

**当前版本：v1.4.2。** 秒杀网站的防护策略持续升级，本项目的成功率也在动态变化。我们非常欢迎社区贡献代码、反馈问题、分享经验。

---

## 免责声明

- 本项目仅供学习交流，不保证每次都能抢到。实测成功率约 **60%**，受网络环境、服务器防护、验证码策略等多重因素影响。
- bigmodel.cn 的防护机制会不定期更新，某些版本的扩展可能在某个时间点失效。**请自行 fork 本仓库，根据实际情况调整策略。**
- 如果你找到了更优的方案，**欢迎提交 PR**，让更多人受益。社区的力量是本项目持续有效的关键。

---

## 功能概览

| 功能 | 说明 |
|------|------|
| 倒计时提醒 | 系统通知 + 角标倒计时（T-60/30/15/10/5 五段提醒，可静音） |
| 验证码预取 | 自动拦截并缓存 Tencent CAPTCHA ticket，秒杀时跳过验证码 |
| 同源请求代理 | 通过 MAIN world 注入绕过 CORS，确保 API 请求正常返回 |
| NTP 校时 | 对 bigmodel.cn 服务器做延迟探测，对齐本地时钟 |
| L1 信息条 | 在 bigmodel.cn 顶栏注入呼吸灯，展示当前时间、目标时间、倒计时与延迟 |
| 智能开火 | Auto 模式按实测 latency 自动触发；支持首枪偏移 + 错峰抖动 + 动态退避（500/555 分别处理） |
| 商品优先级 | 最多 3 个目标按 P1/P2/P3 排序，ticket 按优先级（默认 70/20/10）配比 |
| 动态切换 | 目标 soldout 后自动移除并把剩余 ticket 重新分配到存活商品 |
| 开火可视化 | Fire Matrix 实时展示 offset/stagger/配比/退避与每次发射状态；新增 /pay/preview 调用链路图与错误责任主体翻译，明确区分智谱/腾讯/插件/网络问题 |
| 多平台支持 | 除 bigmodel.cn 外，另支持火山引擎（volcengine.com）Agent Plan / Coding Plan 抢购 |
| API 调试面板 | Popup DEV 模式可直接调用 catalog.ts 中定义的全部 bigmodel.cn API 端点 |

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      Chrome Extension (MV3)                      │
│                                                                   │
│  ┌──────────────┐   ┌──────────────────────────────────────────┐ │
│  │   Background  │   │              bigmodel.cn Tab              │ │
│  │ Service Worker│   │                                           │ │
│  │               │   │  ┌─────────────┐    ┌─────────────────┐  │ │
│  │ • Alarms API  │   │  │ bm-capture  │    │   bm-main.js    │  │ │
│  │ • Badge 角标  │   │  │ (ISOLATED)  │◄──►│  (MAIN world)   │  │ │
│  │ • 通知推送    │   │  │             │    │                  │  │ │
│  │               │   │  │ • Fire 调度 │    │ • XHR 拦截      │  │ │
│  └───────┬───────┘   │  │ • Auth 抓取 │    │ • L1 顶栏注入   │  │ │
│          │           │  │ • Storage桥 │    │ • Fire Matrix   │  │ │
│  ┌───────▼───────┐   │  └─────────────┘    └─────────────────┘  │ │
│  │    Popup       │   │                                           │ │
│  │                │   └──────────────────────────────────────────┘ │
│  │  ┌──────────┐  │                                                 │
│  │  │ DEV 模式 │  │   chrome.storage.local ◄──── 所有组件共享存储  │
│  │  │ API 调试 │  │                                                 │
│  │  └──────────┘  │                                                 │
│  │  ┌──────────┐  │                                                 │
│  │  │ PROD 模式│  │                                                 │
│  │  │ 秒杀操作 │  │                                                 │
│  │  └──────────┘  │                                                 │
│  └────────────────┘                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

**核心工作流：**

```
bm-main.js (MAIN world)          bm-capture (ISOLATED world)
────────────────────────          ───────────────────────────
XHR 拦截到验证码响应               监听 window message
→ window.postMessage(ticket)  →   → storage.setItem('local:ticketPool', ...)
                                  → 累积 ticket 池

倒计时提醒 UI 按钮点击              监听 UI 事件
→ window.postMessage(FIRE) →       → 读取 ticketPool + auth
                                  → 发起批量 fetch 请求
```

**为什么需要 MAIN world 注入？** bigmodel.cn 服务端会拒绝 `chrome-extension://` origin 的请求（返回空 body）。唯一的解决方案是在页面的 MAIN world 中执行 `fetch`，让请求来源为 `https://bigmodel.cn`。详见 `docs/architecture.md`。

---

## 快速开始

### 方式一：下载预编译包（推荐）

1. 下载 zip 压缩包：[miaosha-GLM.zip](https://github.com/Rocke1001feller/miaosha-GLM/releases/download/v1.4.2/miaosha-glm-1.4.2-chrome.zip)
2. 解压 zip 文件（见下方[解压说明](#zip-解压说明)）
3. 打开 Chrome 浏览器，访问 `chrome://extensions`
4. 开启右上角的「开发者模式」
5. 点击「加载已解压的扩展程序」，选择解压后的 `智谱秒杀助手` 文件夹
6. 完成！扩展图标将出现在浏览器工具栏

### 方式二：从源码构建

```bash
# 克隆仓库
git clone https://github.com/Rocke1001feller/miaosha-GLM.git
cd miaosha-GLM

# 安装依赖
pnpm install

# 开发模式（HMR，扩展自动重载）
pnpm dev

# 生产构建（含回归测试）
pnpm build
```

### 使用流程

1. 打开 [bigmodel.cn/glm-coding](https://bigmodel.cn/glm-coding) 并登录
2. 在扩展选项页配置秒杀时间（默认 09:54:59.999 上海时区）
3. 扩展自动预取验证码、校准服务器时间
4. 秒杀瞬间点击「开火」或等待自动开火

### ZIP 解压说明

根据你的操作系统，解压下载的 zip 文件：

**macOS**
- 双击 `miaosha-glm-1.4.2-chrome.zip`，系统自动解压
- 或右键选择「用归档实用工具打开」

**Windows**
- 右键点击 zip 文件 → 选择「全部解压缩」
- 或使用 7-Zip、WinRAR 等工具解压

**Linux**
```bash
unzip miaosha-glm-1.4.2-chrome.zip
```

解压后你会看到一个 `智谱秒杀助手` 文件夹，直接选择该文件夹加载到 Chrome 即可。

---

## 项目结构

```
├── entrypoints/
│   ├── background.ts                # Service Worker：通知 + 角标倒计时
│   ├── bm-early.content.ts          # document_start 注入：运行时命名空间引导
│   ├── bm-capture.content.ts        # bigmodel Content Script (ISOLATED)：验证码/认证/Fire 调度
│   ├── volc-agentplan-capture.content.ts   # 火山引擎 Agent Plan Content Script
│   ├── volc-codingplan-capture.content.ts  # 火山引擎 Coding Plan Content Script
│   ├── popup/                       # Popup 页面 (Svelte 5)
│   └── options/                     # 选项页 (Svelte 5：通用 / 使用 / 架构 / 洞察 / 更新日志)
├── lib/
│   ├── api/                         # Fire 调度/执行、时钟校准、票分配、支付轮询
│   ├── platform/                    # 多平台适配层（registry + bigmodel / 火山引擎 adapters）
│   └── settings/                    # 秒杀时间、验证码、Fire 策略配置
├── src/*-main/                      # 各平台 MAIN world 注入脚本源码（构建为 IIFE）
├── public/                          # 自动生成的注入脚本（勿手动编辑）+ declarativeNetRequest 规则
├── ocr-service/                     # 本地点选验证码 OCR 服务（ddddocr，可选）
├── scripts/                         # 构建脚本（overlay 构建 + zip 打包 + 产物校验）
├── tests/                           # 单元/组件/集成测试（5 层）
└── docs/                            # 架构文档、实现计划与规格
```

> **多平台支持**：本扩展最初面向 bigmodel.cn（智谱 GLM Coding Plan），现已通过 `lib/platform` 适配层扩展支持火山引擎（volcengine.com）的 Agent Plan / Coding Plan 抢购。各平台的 MAIN world 注入脚本源码位于 `src/<platform>-main/`，由 `scripts/build-overlay.js` 编译为 `public/<platform>-main.js`。

---

## 测试

```bash
pnpm test            # 运行全部测试
pnpm test:watch      # 监听模式
pnpm test:ui         # 可视化 UI
```

测试分 5 层：纯逻辑 → 存储层 → bm-main JS → Svelte 组件 → Chrome API 集成。详见 `docs/testing.md`。

---

## 贡献

**欢迎任何形式的贡献！** 特别是：

- 适配 bigmodel.cn 新的防护策略
- 优化开火时序和并发策略
- 提升验证码预取成功率
- 修复 bug、补充测试、完善文档

### 贡献流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 确保测试通过：`pnpm test`
4. 确保构建通过：`pnpm build`
5. 提交 Pull Request

### 问题反馈

如果遇到扩展失效、秒杀失败等情况，请在 Issues 中提交，并附上：

- 浏览器版本
- 扩展版本（构建日期）
- 复现步骤
- 控制台报错截图（如有）

---

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| [WXT](https://wxt.dev) | 0.20.26 | Chrome MV3 扩展框架 |
| [Svelte](https://svelte.dev) | 5.x | Popup / Options UI |
| [Vite](https://vite.dev) | — | 构建工具（WXT 内置） |
| [Vitest](https://vitest.dev) | 4.x | 测试框架 |
| TypeScript | — | 类型安全 |

---

## 相关文档

- [架构与原理](docs/architecture.md) — 整体架构、核心机制、设计决策
- [测试指南](docs/testing.md) — 测试分层、工具链、扩展测试套件

---

## 社区交流

扫码加入 **飞书用户交流群**，与作者和其他用户实时讨论：

<p align="center">
  <img src="public/feishu-community-qr.png" alt="飞书用户交流群二维码" width="220" />
</p>

**适合什么时候加入：**

- 🚀 **秒杀前**：确认配置是否正确、分享当天策略、查看最新防护应对
- 🛠 **使用中遇到问题**：扩展失效、票池异常、Fire Matrix 状态异常时实时求助
- 💡 **想贡献代码**：先在群里同步方案思路，避免重复造轮子
- 📢 **第一时间获取更新**：新版本发布、重大防护变更会先在群里通知

> **注意**：群内讨论与 GitHub Issues 互补 — 简单/即时问题优先群里反馈，bug 报告与功能建议请仍走 Issues 以便追踪。

---

## 许可证

ISC
