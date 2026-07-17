# 抢购助手 — 项目交接文档

## 1. 项目概述

Chrome MV3 浏览器扩展，辅助抢购 bigmodel.cn 的 GLM Coding Plan 限量套餐。

- **名称**: 抢购助手
- **版本**: 1.5.0 (dev 分支)
- **仓库**: github.com/Gh0se4/miaosha-GLM
- **构建**: `pnpm build` → 输出 `output/chrome-mv3/`，Chrome 直接加载该目录
- **加载**: `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `output/chrome-mv3/`

## 2. 架构

```
┌─ Chrome Extension MV3 ────────────────────────────────────────┐
│                                                                │
│  bigmodel.cn 页面                                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ bm-early.js (document_start, MAIN world)                 │ │
│  │   · 生成随机 session namespace (_NS)                     │ │
│  │   · 拦截 XHR/fetch 抓取 batch-preview 产品数据           │ │
│  │   · 守护 window.fetch (getter/setter 防 Sentry 覆盖)     │ │
│  │                                                          │ │
│  │ bm-main.js (document_idle, MAIN world, 12个模块)         │ │
│  │   · 00-css.js: namespace bootstrap + overlay CSS         │ │
│  │   · 02-state.js: 全局状态变量                            │ │
│  │   · 03-xhr.js: XHR 拦截 (batch-preview)                  │ │
│  │   · 04-captcha.js: 验证码录入 + OCR 自动识别             │ │
│  │   · 05-product.js: 产品数据管理                          │ │
│  │   · 06-fetch-bridge.js: DO_FETCH 桥 (MAIN world fetch)   │ │
│  │   · 07-auto-fire.js: 定时自动开火                        │ │
│  │   · 08-overlay.js: 侧边栏面板 UI                         │ │
│  │   · 09-fire-viz.js: Fire Matrix 可视化                   │ │
│  │   · 10-header.js: L1 顶栏信息条                          │ │
│  │   · 10-native-pay-trigger.js: 原生支付弹窗               │ │
│  │   · 12-fire-log.js: 日志记录                             │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ bm-capture.content.ts (document_idle, ISOLATED world)   │ │
│  │   · 注入 bm-main.js 到页面                               │ │
│  │   · 消息中转: MAIN ↔ extension storage                   │ │
│  │   · 执行抢购逻辑: strike/burst/auto-fire                 │ │
│  │   · DO_FETCH 请求代理                                    │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  background.ts (Service Worker)                                │
│    · 倒计时提醒 + badge 角标                                   │
│    · API 请求代理 (CAPTURE_TAB 截图)                           │
│                                                                │
│  Popup / Options (Svelte 5)                                    │
└────────────────────────────────────────────────────────────────┘
```

**通信协议**: MAIN ↔ ISOLATED 通过 `window.postMessage`，标记为 `_NS + 'c'/'e'/'o'`（session 级随机 namespace，防检测）

## 3. 核心功能状态

| 功能 | 状态 | 说明 |
|------|------|------|
| 产品加载 | ✅ | XHR/fetch 拦截页面 batch-preview，被动获取 |
| 验证码录入 | ✅ | 手动点击 TencentCaptcha，ticket 入池 (TTL 5min) |
| OCR 自动验证码 | ⚠️ | 需启动 `ocr-service/ocr_server.py`，勾选 OCR 开关 |
| Fire 串行 (manual) | ✅ | 3s 间隔逐枪发射，一轮打完 |
| BURST 并发 | ✅ | 500ms 间隔，无冷却 |
| Auto 定时开火 | ✅ | 提前 500ms 自动触发，与 manual 共用 scheduleNext |
| 产品优先级 | ✅ | P1/P2/P3，70/20/10 配比 |
| Fire Matrix | ✅ | 实时可视化 |
| 日志 | ⚠️ | sessionStorage，点击 JSON 按钮下载到 Downloads |

## 4. 关键设计决策

### 反检测 (namespace)
所有 DOM ID、postMessage 标记、sessionStorage key 使用 session 级随机 prefix `_NS`。

### 请求路由 (DO_FETCH 桥)
订单请求 `/api/biz/pay/preview` 通过 MAIN world 原生 `window.fetch` 发送（同源），避免 extension origin 被 WAF 识别。ISOLATED world → postMessage → MAIN world → fetch → 返回结果。

### 产品加载 (纯被动)
扩展不主动请求 `/api/biz/pay/batch-preview`。只通过 XHR/fetch 拦截器抓取页面自身的请求结果。避免扩展和页面同时发请求撞 555。

### 票据消耗
Strike 开始时预留所有票，取消时归还未使用的票。阻止重复点火（strike 进行中再次点击 Fire 会提示拒绝）。

### 验证码类型
Tencent CAPTCHA 有时是滑块、有时是点选。OCR 自动跳过滑块，只识别点选（中文点击验证码）。

### WAF 行为
所有日志分析结论：第一轮 Fire 不触发 WAF，WAF 只在第二轮 Fire（停止后重新开始）时触发。因此策略是**一轮打完，不冷却不重试**。

## 5. 已知问题和限制

1. **服务器 555 限流**: 秒杀高峰时服务器全局过载，所有请求返回 555。客户端无法完全解决，只能控制 3s 间隔避免触发单用户限流。
2. **OCR 点击**: 管线已通（下载 → OCR → 坐标 → 点击），但实际点击是否被 captcha 接受需要验证。OCR 服务需手动启动。
3. **WAF 第二轮**: 同一个 session 内第二轮 Fire 必定触发 WAF。解决方案是一轮打完，不要分多轮。
4. **产品加载偶尔卡 Loading**: `loadProducts` 改为轮询后偶尔首次检查时数据未就绪，会短暂显示 Loading。
5. **日志不包含 captcha 请求**: 当前日志只记录 Fire shot，不包含验证码录入和页面 API 调用。
6. **`[early]` 调试日志已删除**: bm-early.js 的产品拦截日志已移除，如果需要调试产品加载需重新加回。

## 6. 构建和发布

```bash
pnpm build                              # 构建到 output/chrome-mv3/
# 加载: Chrome → extensions → 加载已解压 → 选 output/chrome-mv3/
```

OCR 服务（可选）:
```bash
cd ocr-service
bash setup.sh                           # 首次: 创建 venv + 安装依赖
source venv/bin/activate && python3 ocr_server.py  # 启动 (端口 9898)
```

## 7. 参考项目

- `glm-plugin` / `glm-seckill-browser-extension`: 使用 declarativeNetRequest + 远程代理的方案。产品加载通过代理服务器避免 555。OCR 服务 (ddddocr) 源于该项目。
- 我们未采用远程代理方案（依赖第三方服务器），但集成了其 OCR 逻辑和 captcha 选择器。

## 8. 关键文件索引

| 文件 | 作用 |
|------|------|
| `entrypoints/bm-capture.content.ts` | **最核心**: 抢购调度、消息路由、DO_FETCH 桥 |
| `entrypoints/bm-early.content.ts` | 注入 bm-early.js |
| `entrypoints/background.ts` | Service Worker |
| `src/bm-main/04-captcha.js` | 验证码录入 + OCR |
| `src/bm-main/05-product.js` | 产品数据 |
| `src/bm-main/06-fetch-bridge.js` | MAIN world fetch 桥 |
| `src/bm-main/08-overlay.js` | 侧边栏 UI |
| `src/bm-main/12-fire-log.js` | 日志 |
| `public/bm-early.js` | document_start 注入脚本 |
| `lib/platform/adapters/bigmodel/order-pipeline.ts` | 订单请求 + 响应分类 |
| `lib/platform/adapters/bigmodel/request.ts` | xhrRequest + MAIN world fetcher |
| `lib/api/strike-plan.ts` | 票据分配算法 |
| `wxt.config.ts` | 扩展配置 (manifest) |
| `ocr-service/ocr_server.py` | OCR 服务 (glm-plugin 移植) |
