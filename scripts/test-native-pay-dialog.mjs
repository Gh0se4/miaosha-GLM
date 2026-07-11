#!/usr/bin/env node
// scripts/test-native-pay-dialog.mjs
//
// Helper script for manually testing the bigmodel.cn native payment dialog
// pull-up flow used by the 智谱秒杀助手 extension.
//
// This script does NOT run inside the browser. It prints a DevTools Console
// snippet that you can paste on https://bigmodel.cn/glm-coding to simulate a
// successful flash-sale order and verify that the native PayComponent dialog
// opens correctly.
//
// Usage:
//   1. Open https://bigmodel.cn/glm-coding in Chrome with the extension loaded.
//   2. Open DevTools (F12) and select the Console tab.
//   3. Run: node scripts/test-native-pay-dialog.mjs
//   4. Copy the printed code block and paste it into the Console.
//   5. Press Enter. The native payment dialog should appear.
//   6. Complete (or close) the secondary Tencent captcha if shown.
//   7. The dialog should stay open until you click its X button.

const snippet = `(function() {
  if (!window.__bmPaymentIntercept) {
    console.warn('[qg-test] bm-main.js does not seem to be loaded. Make sure the extension is injected on bigmodel.cn/glm-coding.');
    return;
  }
  window.postMessage({
    __miaosha_cmd: true,
    type: 'TEST_NATIVE_PAYMENT',
    data: { payType: 'ALI', amount: 159 }
  }, window.location.origin);
  console.log('[qg-test] Dispatched TEST_NATIVE_PAYMENT. The native payment dialog should open in test mode.');
})();`;

console.log('\n=== 智谱秒杀助手 — 原生支付弹窗手动测试 ===\n');
console.log('请按以下步骤操作：');
console.log('1. 确保你已经在 https://bigmodel.cn/glm-coding 页面。');
console.log('2. 确保插件已注入（页面左上角应出现「智谱秒杀助手」面板和顶部 L1 信息条）。');
console.log('3. 打开 DevTools Console，复制并粘贴下面的代码，然后按 Enter。');
console.log('4. 预期：原生支付弹窗出现；完成/关闭二次验证码后弹窗仍保持打开。');
console.log('5. 只有点击原生弹窗右上角的 X 才能关闭它。\n');
console.log('--- 开始复制 ---');
console.log(snippet);
console.log('--- 结束复制 ---\n');
console.log('你也可以直接点击顶部 L1 信息条右侧的 🔄 Test Pay 按钮达到同样效果。');
