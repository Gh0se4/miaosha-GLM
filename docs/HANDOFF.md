# 交接文档 · 分析与改进（2026-07）

本文件记录 `claude/project-analysis-improvement-03s6xy` 分支的一轮系统性分析与改进：**已做什么、怎么验证、还剩什么、以及后续如何安全接手**（尤其是唯一未做的高价值项 —— volc overlay JS 去重）。

> 方法：独立通读全部核心逻辑 + 一个 7 维度、14-agent 的对抗式验证工作流，产出 33 条 CONFIRMED + 6 条 PLAUSIBLE 发现，逐条决策。

---

## 1. 一句话结论

从「测试一装即挂、零 CI」到 **`pnpm test` 265 通过 + typecheck 干净 + build 通过 + zip 产物 + 首个 CI**，净删约 2969 行（死代码 + 去重），并修复了包括「抢到后误报支付成功」「抢到后拉不起支付弹窗」在内的多个真实 bug；volc 的 TS 适配层与 MAIN-world overlay 均已去重（§4.1），版本漂移已根治，MAIN-world 消息处理器已加跨窗口守卫。已在**全新 `pnpm install --frozen-lockfile` 环境**下验证 install→typecheck→test→build→zip 全绿（开箱即用）。剩余仅为**产品/品牌/发布决策**（命名统一、下载链接与站内更新日志、ESLint 专项），见 §4.2。

---

## 2. 已完成（20+ 个提交，均已签名；详见 `git log dev..HEAD`）

| 类别 | 内容 |
|------|------|
| 工程 | `fix(test)` 恢复 Vitest 启动（Vite 8 Rolldown optimizer 的 `node:module`，旧 `deps.optimizer` 开关已失效）；`chore(ci)` 新增 `typecheck` 脚本 + GitHub Actions |
| 高危 bug | `fix(payment)` 支付轮询把信封 `code===200` 误判为付款成功（未付即报“已确认”）→ 只按 `data.status`；`findPayComponent()` 提前缓存失败致抢到后拉不起支付弹窗 → 只缓存成功 |
| 正确性 | 提醒横幅模板插值 bug；时钟校准偏晚（Date 秒级量化 + `+rtt/2` 重复补偿）；OK 成功角标提前消失；通知“稍后提醒”空操作；volc catalog 互相覆盖；BURST 标签 200/500ms；Fire Matrix 日志空白；L1 顶栏单次注入 |
| 安全 | OCR 服务 CORS `*` → 平台白名单；`MAX_CONTENT_LENGTH`；对 permutations 输入设上限防阶乘级 DoS |
| 清理 | 删死代码（`fire-plan.ts`、registry `forHost/matchHost`、5 个孤立 store 工厂、`OCR_SOLVE` 处理器）；统一忽略 `public/*-main.js` 并取消跟踪 volc 生成产物；一批陈旧文档修正 |
| 去重 | volc **TS 适配层**抽成 `volcengine-shared` 工厂（order-pipeline / product-probe / adapter）；volc **MAIN-world overlay** 6 个模块抽入 `src/volc-shared/`，变体只留 `00-config.js`（见 §4.1）。两处均保留具名导出/生成产物名，调用方无感 |
| 测试 | 为支付关键代码补单测：volc 两条下单流水线、bundle-parser、auth 捕获、overlay pricing（volc-shared） |

逐条提交见 `git log dev..HEAD`。逐条发现（file:line / 复现 / 建议 / 判定理由）见分支交付的 `workflow-findings.json`（未入库，随会话交付）。

---

## 3. 如何验证 / 本地开发

```bash
pnpm install
pnpm typecheck   # wxt prepare && tsc --noEmit
pnpm test        # vitest，当前 265 passed
pnpm build       # build-overlay → wxt build → verify-no-minifier-collision
```

- 测试分层与 harness 见 `docs/testing.md`；整体架构见 `docs/architecture.md`。
- `src/*-main/` 是注入 MAIN world 的原生 JS，`scripts/build-overlay.js` 把每个目录拼成 `public/<dir>.js`（IIFE）。这些生成物**已全部 gitignore**，勿手动编辑生成物。

---

## 4. 去重与剩余工作

### 4.1 【已完成】volc overlay JS 去重

**已落地**（见提交 `refactor(overlay): share volc MAIN-world source`）：6 个近似模块（10-shared / 11-fetch-bridge / 20-pricing / 30-catalog / 40-ui / 50-order）移入 `src/volc-shared/`，标识符前缀统一为 `__volc_`，注释/日志通用化；两变体目录只各留 `00-config.js`（唯一真实差异，含 productCode / payPath / globalName / displayNames 等）。`scripts/build-overlay.js` 通过 `SHARED_INCLUDES` 把「变体 00-config + 共享模块」拼成各自的 `public/<variant>-main.js`。

去重前做了等价性证明（归一化前缀后逐文件仅注释不同）+ 去重后校验（生成物含正确产品码且无交叉污染、无残留旧前缀、标识符 IIFE 局部不跨变体冲突、注入 guard 仍区分）。overlay pricing 逻辑测试合并为 `tests/unit/volc-shared/`。净删约 500 行重复。

> 历史背景（去重前现状，保留供参考）：`src/volc-agentplan-main/` 与 `src/volc-codingplan-main/` 曾各 7 文件、~1070 行高度重复，逐文件差异（token 归一化前）：

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

### 4.2 需产品/发布决策的项（**仅剩这些需人工**）
- **命名统一**：目录 `miaosha-GLM` / package `qianggou-GLM` / manifest `抢购助手` / README `智谱秒杀助手`，且混用「秒杀 / 抢购」。属品牌决策，需维护者定一个规范名与术语后统一。
- **README 下载链接 + 站内更新日志**：README 下载链接指向上游 v1.4.2 release（本 fork 无 1.5.0 release，直接改会 404）；`entrypoints/options/App.svelte` 与 `ReleaseLogPage.svelte` 的更新日志仍是 v1.4.2 文案。发 1.5.0 release 时一并更新，并补写 1.5.0 更新日志（内容需维护者定）。
- **ESLint/Prettier**：对 ~6.4k 行手写 IIFE 引入 lint/format 会一次性涌现大量既有告警（Prettier 更会产生巨量重排 diff），应作为独立 PR（先定规则、配置 IIFE 全局、再批量修），否则会破坏 `pnpm build`/CI 的「开箱即用」。

### 4.3 本轮已补做（原「剩余」项）
- ✅ **版本漂移**：`build-overlay.js` 现把 `__PKG_VERSION__` 占位替换为 package 版本（overlay 回退版本不再漂移）；`zip-prepare.mjs` 早已从 package 版本派生 zip 名。
- ✅ **MAIN-world `e.source` 检查**：5 个处理器已加 `e.source && e.source !== window`（跨窗口拦截，同窗口/测试无 source 派发放行）。
- ✅ **`client.ts` 单测**（parseResponseBody / buildHeaders / findBigmodelTabId / testEndpoint 错误路径）。
- ✅ **`isReady()` 平台化**：接受 `authorization`（bigmodel）或 `x-csrf-token`（volcengine）。

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

- 分支 `claude/project-analysis-improvement-03s6xy` 已推送到 GitHub（20+ 提交，详见 `git log dev..HEAD`），基于 `dev`。已在全新 `pnpm install --frozen-lockfile` 环境验证开箱即用。
- 未创建 PR。合并前建议按 §3 跑一遍 typecheck/test/build。
