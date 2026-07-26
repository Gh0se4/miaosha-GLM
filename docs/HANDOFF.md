# 交接文档 · 分析与改进（2026-07）

本文件记录 `claude/project-analysis-improvement-03s6xy` 分支的一轮系统性分析与改进：**已做什么、怎么验证、还剩什么、以及后续如何安全接手**（尤其是唯一未做的高价值项 —— volc overlay JS 去重）。

> 方法：独立通读全部核心逻辑 + 一个 7 维度、14-agent 的对抗式验证工作流，产出 33 条 CONFIRMED + 6 条 PLAUSIBLE 发现，逐条决策。

---

## 1. 一句话结论

从「测试一装即挂、零 CI」到 **`pnpm test` 257 通过 + typecheck 干净 + build 通过 + 首个 CI**，净删约 2100 行（死代码 + 去重），并修复了包括「抢到后误报支付成功」「抢到后拉不起支付弹窗」在内的多个真实 bug。**所有可安全自主执行的项均已完成**；剩余项要么需产品/发布决策，要么是对无集成测试的真金白银 overlay 代码做重构，均按理由留待人工接手（见 §4）。

---

## 2. 已完成（15 个提交，均已签名）

| 类别 | 内容 |
|------|------|
| 工程 | `fix(test)` 恢复 Vitest 启动（Vite 8 Rolldown optimizer 的 `node:module`，旧 `deps.optimizer` 开关已失效）；`chore(ci)` 新增 `typecheck` 脚本 + GitHub Actions |
| 高危 bug | `fix(payment)` 支付轮询把信封 `code===200` 误判为付款成功（未付即报“已确认”）→ 只按 `data.status`；`findPayComponent()` 提前缓存失败致抢到后拉不起支付弹窗 → 只缓存成功 |
| 正确性 | 提醒横幅模板插值 bug；时钟校准偏晚（Date 秒级量化 + `+rtt/2` 重复补偿）；OK 成功角标提前消失；通知“稍后提醒”空操作；volc catalog 互相覆盖；BURST 标签 200/500ms；Fire Matrix 日志空白；L1 顶栏单次注入 |
| 安全 | OCR 服务 CORS `*` → 平台白名单；`MAX_CONTENT_LENGTH`；对 permutations 输入设上限防阶乘级 DoS |
| 清理 | 删死代码（`fire-plan.ts`、registry `forHost/matchHost`、5 个孤立 store 工厂、`OCR_SOLVE` 处理器）；统一忽略 `public/*-main.js` 并取消跟踪 volc 生成产物；一批陈旧文档修正 |
| 去重 | volc **TS 适配层**抽成 `volcengine-shared` 工厂（order-pipeline / product-probe / adapter），各变体收敛为「配置 + 工厂调用」，保留全部具名导出 |
| 测试 | 为支付关键代码补 20 个单测：volc 两条下单流水线、bundle-parser、auth 捕获 |

逐条提交见 `git log dev..HEAD`。逐条发现（file:line / 复现 / 建议 / 判定理由）见分支交付的 `workflow-findings.json`（未入库，随会话交付）。

---

## 3. 如何验证 / 本地开发

```bash
pnpm install
pnpm typecheck   # wxt prepare && tsc --noEmit
pnpm test        # vitest，当前 257 passed
pnpm build       # build-overlay → wxt build → verify-no-minifier-collision
```

- 测试分层与 harness 见 `docs/testing.md`；整体架构见 `docs/architecture.md`。
- `src/*-main/` 是注入 MAIN world 的原生 JS，`scripts/build-overlay.js` 把每个目录拼成 `public/<dir>.js`（IIFE）。这些生成物**已全部 gitignore**，勿手动编辑生成物。

---

## 4. 剩余工作（未做，附原因与接手指引）

### 4.1 【高价值 · 唯一未做的“高”项】volc overlay JS 去重

**现状**：`src/volc-agentplan-main/` 与 `src/volc-codingplan-main/` 各 7 个文件、~1070 行，高度重复。当前逐文件差异（token 归一化前）：

| 文件 | 差异行 / 总行 | 说明 |
|------|---------------|------|
| 00-config.js | 26 / ~20 | **真实配置差异**（产品码、默认商品、展示名、URL） |
| 10-shared.js | 40 / 183 | 基本只是标识符前缀 + 注释 |
| 11-fetch-bridge.js | 2 / 39 | 仅注释 |
| 20-pricing.js | 28 / 97 | 前缀 + 产品码 |
| 30-catalog.js | 10 / 40 | 前缀 + 展示名 |
| 40-ui.js | **376 / 555** | 前缀 + “Agent/Coding Plan” 标签 + 展示名（**UI 层**） |
| 50-order.js | 64 / 138 | 前缀 + 产品码 + payPath |

差异 token 归为几类：① 标识符前缀 `__volc_agentplan_` / `__volc_codingplan_`；② 文案 `Agent Plan` / `Coding Plan`；③ 产品码 `ark_subscription` / `ark_bd`；④ 全局名 `__activity__agentplan__` / `__activity__codingplan__`；⑤ 展示名映射与 payPath；这些的**其余部分逐字节相同**。

**推荐做法**（与 `lib/platform/adapters/volcengine-shared` 已落地的 TS 工厂思路一致）：
1. 新建共享目录（如 `src/volc-shared/`，名字**不以 `-main` 结尾**，使 build-overlay 不把它当独立输出）。
2. 把 6 个近似文件移入共享目录，并把差异 token 全部改为**引用变量**：函数标识符前缀统一为 `__volc_`（IIFE 内局部、无碰撞）；`ark_subscription` 等改为读 `00-config.js` 里的 `__volc_config.productCode`、`payPath`、`globalName`、`displayNames`、`planLabel` 等。
3. 每个变体目录只保留 `00-config.js`（定义上述配置变量 + `defaultProductId` 等）。
4. 改 `scripts/build-overlay.js`：对每个 `*-main` 变体，拼接顺序为「变体 `00-config.js` + 共享目录文件」（按数字前缀排序），仍产出 `public/<variant>-main.js`。

**为何我没做**：40-ui.js 是真金白银的下单/定价 **UI**，且 **codingplan overlay 目前零集成/E2E 测试**；~500 行的 token 替换若有一处漏改，会让某个变体用错文案/产品码或触发运行时 `ReferenceError`，而无测试能兜住。这属于「改无测试的支付关键代码」，不宜盲改。

**接手时的验证清单**（可把风险降到可接受）：
1. 前缀统一后，`grep -r '__volc_agentplan_\|__volc_codingplan_' src/volc-shared` 必须为 **0**（否则有悬空函数引用）。
2. `pnpm build` 通过（esbuild/terser catch 语法 + minifier 碰撞）。
3. 构建后对生成物做**配置值断言**：`public/volc-codingplan-main.js` 应含 `ark_bd` / `Coding Plan` 且**不含** `ark_subscription` / `Agent Plan`；agentplan 反之。
4. **先补 codingplan 的 pricing/order 单测**（照抄 `tests/unit/volc-agentplan-main/`，见下），去重后两变体测试都要过。
5. 注意：统一前缀会改动 `__volc_agentplan_*` 标识符，**现有 `tests/unit/volc-agentplan-main/pricing.test.ts` 引用了这些名字，需同步改为新的统一前缀**。

**更低风险的替代/前置**：先做「防漂移」而非「去重」——
- 补 `tests/unit/volc-codingplan-main/`（pricing + order），照抄 agentplan 的 `_harness.ts` 与 `pricing.test.ts`，把标识符前缀与产品码换成 codingplan（`__volc_codingplan_fetchPrice`、`ark_bd`、`Coding_Plan_*`）。这直接消除「codingplan overlay 零测试」的确认发现，且不动生产代码。
- 可加一个「结构一致性」测试：读两目录、对差异 token 归一化后断言剩余内容一致，从而**自动捕获未来漂移**——在不做去重的前提下解决该发现的核心风险。

### 4.2 需产品/发布决策的项
- **README 版本 v1.4.2 vs package.json 1.5.0+ 下载链接**：下载链接指向上游 v1.4.2 release；本 fork 无 1.5.0 release，直接改链接会 404。建议：发 1.5.0 release 后更新，或让 `scripts/zip-prepare.mjs` 从 package 版本派生 zip 文件名以杜绝漂移。（`src/bm-main/12-fire-log.js` 里 legacy 下载还硬编码 `extensionVersion: '1.4.2'`，一并处理。）
- **命名统一**：目录 `miaosha-GLM` / package `qianggou-GLM` / manifest `抢购助手` / README `智谱秒杀助手`，且混用「秒杀 / 抢购」。建议统一一个规范名与术语。

### 4.3 独立专项
- **引入 ESLint/Prettier + lint CI 步**：对 ~6.4k 行手写 IIFE 引入 lint 会一次性涌现大量既有告警，应作为独立 PR（先定规则、再批量修）。

### 4.4 低优先 / 纵深防御
- **MAIN-world 5 个消息处理器缺 `e.source !== window`**（`04-captcha.js:180`、`09-fire-viz.js:621`、`12-fire-log.js:273`、`10-native-pay-trigger.js:296/306`）：纯纵深防御（命名空间随机 marker 已挡跨源）。**注意**：直接加会破坏以「无 source 派发消息」的测试 harness（`tests/unit/bm-main/fire-log-store.test.ts:690`、`tests/unit/entrypoints/bm-capture-scope.test.ts:56`），需同时让 harness 以 `source: window` 派发。本轮曾尝试后回退。
- `lib/api/client.ts` 单测（DEV 面板专用，价值低）；`shared/stores` 的 `isReady()` 硬编码 `authorization` 头（对 volc 恒 false，但目前无调用方）。

---

## 5. 分析中发现的关键坑（给后续贡献者）

1. **Vitest 启动依赖 optimizeDeps 外置 node 内建**（`vitest.config.ts`）：Vite 8 的 Rolldown optimizer 会注入 import `node:module` 的运行时 helper，为浏览器目标预打包时无法解析而**整套测试启动即崩**。修法：`optimizeDeps.rollupOptions.external:[/^node:/]`。旧的 `test.deps.optimizer.*.enabled:false` 在此工具链下**无效**。升级 vite/vitest 时留意。
2. **时钟校准精度有硬上限**（`lib/api/runtime-calibration.ts`）：偏移基于 HTTP `Date` 头（**秒级**精度）。本轮已修正系统性偏晚（+~500ms 量化校正）与 `+rtt/2` 重复补偿，但**残留亚秒级不确定性**。⚠️ 改动会改变实际开火时序——`src/bm-main/07-auto-fire.js` 里 `EARLY_MS`/`rttCompensation` 等手调余量**应结合真实抢购数据复核**。若能拿到毫秒级服务器时间源更佳。
3. **OCR 服务 CORS 收紧需回归验证**（`ocr-service/*.py`）：已从 `*` 改为反射 bigmodel.cn / volcengine.com 源。content-script fetch 实际发出的 Origin 未能在本环境验证——**接手请对真实 OCR 调用做一次回归**，确认 allowlist 覆盖到位。
4. **MAIN-world 注入的信任边界**：overlay 运行在页面 MAIN world，命名空间 marker 存于同源可读的 `sessionStorage` 并经 `GET_NAMESPACE` 广播——这是注入方案的固有信任边界，非可轻易关闭的漏洞。
5. **生成产物勿入库**：`public/*-main.js` 由 build 生成、已 gitignore；两 volc bundle 之前被误跟踪（每次 build 产生无谓 diff），本轮已取消跟踪。
6. **构建为三步**：`build-overlay → wxt build → verify-no-minifier-collision`。默认 minifier 曾复用被 mangle 的标识符导致语义损坏，故 `wxt.config.ts` 固定用 terser + `keep_fnames`，并有碰撞校验脚本兜底。

---

## 6. 分支 / 推送状态

- 分支 `claude/project-analysis-improvement-03s6xy` 已推送到 GitHub（15 提交），基于 `dev`。
- 未创建 PR。合并前建议按 §3 跑一遍 typecheck/test/build。
