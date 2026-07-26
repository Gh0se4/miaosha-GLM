# 智谱秒杀助手 — 代码库架构与基本原理

**版本**: 基于 2026-05-30 代码状态  
**构建工具**: WXT 0.20.26 · Vite · TypeScript · Svelte 5  
**扩展类型**: Chrome MV3 (Manifest V3)

> **范围说明**：本文档主要描述 bigmodel.cn（智谱 GLM）这条核心链路的原理与设计决策。项目此后已扩展为**多平台**架构——通过 `lib/platform/` 下的适配层（`registry.ts` + 各平台 `adapters/`）额外支持火山引擎（volcengine.com）的 Agent Plan / Coding Plan 抢购。各平台的 MAIN world 注入脚本源码位于 `src/<platform>-main/`，由 `scripts/build-overlay.js` 编译为 `public/<platform>-main.js`。下文中以 bigmodel 为例讲解的同源请求代理、Ticket 池、Auth 捕获等机制，在其它平台的适配器中以同构方式实现。

---

## 1. 产品目标

智谱 AI（bigmodel.cn）定期举办"秒杀"活动：在固定时间点（默认 09:54:59.999 上海时区）开放限量套餐购买，额度极其有限，需要抢购。

本扩展的核心目标：**让用户在秒杀开始前做好准备、在秒杀瞬间以最快速度完成下单**。

功能按需求编号（R1–R4）组织：

| 需求 | 功能 | 载体 |
|------|------|------|
| R1 | 系统通知倒计时提醒（60/30/15 分钟前，T-5 后停止） | Background service worker |
| R2 | 验证码预取（Tencent CAPTCHA ticket 池） | bm-capture content script + bm-main |
| R3 | bigmodel.cn 标签页内视觉+音频提醒 | bm-capture content script |
| R4 | 扩展图标角标倒计时 | Background service worker |
| DEV | API 调试面板（直接调用 bigmodel API） | Popup DEV 模式 |
| PROD | 秒杀操作面板（一键开火、支付轮询） | Popup PROD 模式 |

---

## 2. 整体架构

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
│  │               │   │  │ • 倒计时UI  │    │ • XHR 拦截      │  │ │
│  └───────┬───────┘   │  │ • Auth抓取  │    │ • 验证码监听     │  │ │
│          │           │  │ • Storage桥 │    │ • 秒杀火力控制   │  │ │
│  ┌───────▼───────┐   │  └─────────────┘    └─────────────────┘  │ │
│  │    Popup       │   │                                           │ │
│  │                │   └──────────────────────────────────────────┘ │
│  │  ┌──────────┐  │                                                 │
│  │  │  DEV 模式│  │   chrome.storage.local ◄──── 所有组件共享存储  │
│  │  │  API调试  │  │                                                 │
│  │  └──────────┘  │                                                 │
│  │  ┌──────────┐  │                                                 │
│  │  │ PROD 模式│  │                                                 │
│  │  │ 秒杀操作  │  │                                                 │
│  │  └──────────┘  │                                                 │
│  └────────────────┘                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Entrypoints（入口点）

WXT 的 `entrypoints/` 目录中每个文件/目录对应一个扩展入口点，编译后各自独立打包。

### 3.1 `entrypoints/background.ts` — 后台 Service Worker

**职责**: R1（system notifications）+ R4（badge 角标）

Chrome MV3 的 service worker 在浏览器关闭时会被停止，`chrome.alarms` 是唯一可以在 SW 停止后仍能触发回调的机制。

**关键设计约束**：`chrome.alarms.onAlarm.addListener` **必须**在顶层注册（不能在 async 函数内），否则 SW 被唤醒后会错过事件。

工作流：
```
popup/options 写入 saleTimeConfig
        ↓
background.ts 读取配置 → 计算下次秒杀时间
        ↓
setTimeout 设定 60/30/15 分钟前触发
        ↓
触发时: chrome.notifications.create + chrome.action.setBadgeText
```

### 3.2 `entrypoints/bm-capture.content.ts` — bigmodel.cn 页面内 Content Script

**职责**: R2（验证码中继）+ R3（页面内提醒）+ Auth 捕获

运行在 **ISOLATED world**，可以访问 `chrome.*` API 和 WXT `storage`，但不能访问页面的 JS 变量。

两个职责需要和 `bm-main.js`（MAIN world）协作：

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

**Auth 捕获**：`captureFromTab()` 在 MAIN world 执行 `extractAuthFromPage()`，从 `document.cookie`（JWT）和 `localStorage`（org/project）读取当前 session 凭证，写回 `local:authHeaders`。

### 3.3 `entrypoints/popup/` — Popup 页面

Svelte 5 应用，380×520px，两个模式通过 Topbar 切换：

```
App.svelte
├── Topbar.svelte          ← DEV / PROD 切换按钮
├── DevContent.svelte      ← DEV 模式：API 测试面板
│   ├── AuthStatusBadge    ← 显示当前 auth 状态
│   ├── ApiEndpointCard    ← 单个 API 卡片（请求/响应）
│   └── TestResultPanel    ← JSON 高亮渲染
├── ProdContent.svelte     ← PROD 模式：秒杀操作面板
│   └── PaymentCard        ← 支付二维码 + 状态轮询
└── Footer.svelte          ← 版本信息
```

### 3.4 `entrypoints/options/` — 选项页

秒杀时间配置（小时/分钟/时区），写入 `local:saleTimeConfig`。

---

## 4. 核心机制：同源请求代理

### 为什么需要代理？

bigmodel.cn 的 API 检查请求来源：

| 请求来源 | 服务端响应 |
|----------|-----------|
| bigmodel.cn 页面（同源） | 完整 JSON body（正常） |
| `chrome-extension://` origin | `content-length: 0`（body 被服务端拒绝） |

### 解决方案：`executeScript` + `world: 'MAIN'`

`lib/api/client.ts` 的 `fetchFromBigmodelPage()` 函数：

1. 找到一个已打开的 bigmodel.cn 标签页 ID
2. 用 `chrome.scripting.executeScript` 将 async fetch 函数注入到该 tab 的 **MAIN world**
3. 注入函数在页面 JS 上下文中执行，fetch 的来源是 `https://bigmodel.cn`（同源）
4. 结果通过 `results[0].result` 返回给 popup

```
Popup Context                    bigmodel.cn Tab (MAIN world)
─────────────────                ─────────────────────────────
chrome.scripting.executeScript
  target: { tabId }
  world: 'MAIN'
  args: [url, method, headers, body]
  func: async (url, ...) => {
    const r = await fetch(url, ...)  ← 同源 fetch，服务端正常响应
    return { status, headers, bodyText }
  }
         ──────────────────────────►
                                   fetch('https://bigmodel.cn/api/...')
                                   ← 完整 response body
         ◄──────────────────────────
  results[0].result.bodyText     返回 4860B JSON
```

**权限要求**：
- `permissions: ['scripting', 'tabs']`
- `host_permissions: ['*://*.bigmodel.cn/*']`（缺少此项则 executeScript 失败）

---

## 5. Auth 系统

### 凭证结构

```typescript
interface AuthHeaders {
  authorization: string;        // "Bearer eyJhbGciOiJIUzUxMiJ9..."
  bigmodelOrganization: string; // "org-7369f0B6C8DA44C0B70ee373c986bf81"
  bigmodelProject: string;      // "proj_015E67feC12A4605932AeD380dA2cb88"
}
```

### 存储

WXT storage key: `local:authHeaders`（对应 `chrome.storage.local['local:authHeaders']`）

### 获取路径

```
captureFromTab()
  └→ executeScript(bigmodel.cn tab, MAIN world)
       └→ 读 document.cookie['bigmodel_token_production']  → authorization
       └→ 读 localStorage['Bigmodel-Organization']         → bigmodelOrganization
       └→ 读 localStorage['Bigmodel-Project']              → bigmodelProject
       └→ 返回 AuthHeaders 对象
  └→ authStore.set(captured)   ← 写入 chrome.storage.local
  └→ return captured
```

### 生命周期与刷新策略

**重要**：bigmodel.cn 的 JWT 在用户重新登录时会轮换。缓存的 auth 可能随时失效。

`DevContent.svelte` 的 `$effect` 在 popup 每次打开时：
1. **首先** 调用 `captureFromTab()` 抓取 tab 当前有效 token
2. **兜底** 在无 bigmodel.cn tab 时，使用 `authStore.get()` 读缓存

这确保了 DEV 调试面板永远使用有效 token。

---

## 6. Ticket（验证码）系统

Tencent CAPTCHA 每次使用后失效，且有效期 5 分钟（错误码 8 即 ticket expired）。

### Ticket 池设计

```typescript
// local:ticketPool 条目结构
interface Ticket {
  ticket: string;   // Tencent CAPTCHA ticket
  randstr: string;  // 配套 randstr
  createdAt: number;
}
```

- 最多存 20 个 ticket（`MAX_POOL_SIZE = 20`）
- 每次读取前自动清除超过 5 分钟的过期 ticket
- 去重：相同 `ticket` 字符串不重复入池

### 获取流程

```
用户在 bigmodel.cn 通过 CAPTCHA
  ↓
bm-main.js (XHR 拦截) 捕获到 ticket + randstr
  ↓
window.postMessage → bm-capture.content.ts
  ↓
写入 chrome.storage.local['local:ticketPool']
```

### 使用流程（秒杀触发）

```
用户点击"开火"按钮（PROD 模式或 bm-main 覆盖层）
  ↓
bm-capture.content.ts 读取 local:ticketPool
  ↓
buildAutoFirePlan() 按优先级与过期紧迫度分配 ticket
  ↓
对每个 (ticket × productId) 发起 /api/biz/pay/preview 请求
```

---

## 7. Storage 架构

所有状态通过 `chrome.storage.local` 在扩展各组件间共享：

| WXT Key | 实际 Storage Key | 类型 | 写入者 | 读取者 |
|---------|-----------------|------|--------|--------|
| `local:authHeaders` | `local:authHeaders` | `AuthHeaders` | bm-capture, authStore.set | popup, bm-capture |
| `local:ticketPool` | `local:ticketPool` | `Ticket[]` | bm-capture | bm-capture (开火时) |
| `local:saleTimeConfig` | `local:saleTimeConfig` | `SaleTimeConfig` | options 页 | background, bm-capture |
| `local:devMode` | `local:devMode` | `'development'\|'production'` | popup Topbar | popup App.svelte |
| `local:selectedProducts` | `local:selectedProducts` | `{priorityList: Array<{productId, percentage}>, count, version}` | bm-main 覆盖层 | bm-capture (开火时) |

**WXT storage 命名约定**: `local:` 前缀表示 `chrome.storage.local`（区别于 `session:` 和 `sync:`）。WXT 的 `storage.setItem('local:foo', v)` 等价于 `chrome.storage.local.set({'local:foo': v})`——key 是字面量，不做前缀 strip。

---

## 8. MAIN World 注入脚本（bm-main.js）

`public/bm-main.js` 作为 `web_accessible_resources` 注册，由 bm-capture 动态注入到 bigmodel.cn 页面：

```typescript
// bm-capture.content.ts
const script = document.createElement('script');
script.src = chrome.runtime.getURL('/bm-main.js');
document.head.appendChild(script);
```

在 MAIN world 运行意味着它可以：
- 拦截原生 `XMLHttpRequest`（通过 prototype 覆盖）
- 访问页面 React/Vue 的全局状态（如有）
- 读写 `document.cookie` 和 `localStorage`
- 与 ISOLATED world 通过 `window.postMessage` / `window.addEventListener('message')` 通信

**bm-main.js 的主要功能**：
1. XHR 拦截 → 捕获 `/api/biz/pay/batch-preview` 返回的商品列表
2. XHR 拦截 → 捕获 Tencent CAPTCHA 验证成功返回的 ticket
3. 渲染秒杀覆盖层 UI（拖拽、商品选择、ticket 计数、一键开火）
4. 监听覆盖层 UI 事件 → `window.postMessage` → bm-capture

---

## 9. 构建与开发

### 目录结构

```
/
├── entrypoints/
│   ├── background.ts          # Service worker
│   ├── bm-capture.content.ts  # Content script (ISOLATED)
│   ├── popup/                 # Popup 页面 (Svelte 5)
│   └── options/               # 选项页 (Svelte 5)
├── lib/
│   ├── api/
│   │   ├── types.ts           # 共享类型定义
│   │   ├── catalog.ts         # API 端点目录（7个端点）
│   │   ├── client.ts          # executeScript 代理请求
│   │   ├── auth-store.ts      # Auth CRUD + captureFromTab
│   │   └── fire-plan.ts       # ticket 分配与自动开火计划
│   └── settings/
│       └── dev.ts             # DevMode 设置
├── public/
│   └── bm-main.js             # MAIN world 注入脚本（静态文件）
├── output/chrome-mv3/         # 构建产物（不提交 git）
└── wxt.config.ts              # 扩展配置
```

### 命令

```bash
npm run dev      # 开发模式（HMR，扩展自动重载）
npm run build    # 生产构建 → output/chrome-mv3/
```

### 加载扩展

`chrome://extensions` → 开发者模式 → 加载已解压的扩展 → 选择 `output/chrome-mv3/`

---

## 10. 关键设计决策与原理

### D1：为什么选择 MAIN world + executeScript 而非 background fetch

Background service worker 可以发 `fetch`，但请求的 `origin` 是 `chrome-extension://fmjg...`，bigmodel.cn 服务端会对此 origin 返回 `content-length: 0` 的空 body。

直接在 content script（ISOLATED world）发 `fetch` 同样存在此问题。

唯一能以 `https://bigmodel.cn` 为 origin 发请求的方式，是在该页面的 MAIN world 里执行代码。`chrome.scripting.executeScript` + `world: 'MAIN'` 是标准 MV3 实现方案。

### D2：为什么 bm-main.js 是静态文件而非编译产物

`chrome.scripting.executeScript` 的 `func` 参数虽然可以注入函数，但对于复杂 UI（拖拽覆盖层、商品选择）逻辑，用字面量函数传递不现实。

`bm-main.js` 作为 `web_accessible_resources` 静态文件，通过 `<script>` 标签注入，代码可以自由使用任意 DOM API，不受 `args` 序列化限制。

### D3：为什么 Ticket 池需要 TTL

Tencent CAPTCHA 的 ticket 有效期约 5 分钟（超期返回错误码 8）。如果用户提前预取了 ticket 但秒杀推迟，过期的 ticket 会导致下单失败。TTL 自动淘汰确保池中始终只有有效 ticket。

### D4：为什么 Auth 每次 popup 打开时都刷新

DEV 调试面板是核心工具，依赖有效 JWT。用户可能在：
- 重新登录 bigmodel.cn（JWT 轮换）
- 切换组织/项目（org/project ID 变化）

任何缓存都可能导致 API 请求失败（服务端返回 `content-length: 0` 或 1001 认证错误）。每次 popup 打开时主动从 tab 抓取当前 session 凭证，是最简单也最可靠的方案。
