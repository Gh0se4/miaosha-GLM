// Order creation and message handling for the volcengine MAIN-world overlay (shared by Agent & Coding Plan).

async function __volc_tryOrder(product, indexKey) {
  const cookies = __volc_getCookies();
  const csrf = cookies['csrfToken'];
  const webId = cookies['monitor_huoshan_web_id'];
  if (!csrf || !webId) {
    __volc_setStatus('未登录，无法刷新库存');
    __volc_stopRefresh('未登录，已停止刷新');
    return { ok: false, retryable: false };
  }

  const tag = __volc_formatProductTag(product);

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'x-csrf-token': csrf,
    'monitor-huoshan-web-id': webId,
    'x-language': 'zh',
    'x-use-bff-version': '1',
  };
  if (cookies['monitor_utm']) {
    headers['monitor-utm'] = cookies['monitor_utm'];
  }

  const body = JSON.stringify({
    IndexKey: indexKey,
    ConfigList: [product.raw.configBody],
    SignPay: true,
  });

  __volc_setStatus(tag + '正在尝试下单…');
  let res;
  try {
    res = await fetch(
      'https://www.volcengine.com/api/v2/top/activity/bill_volc_provider/CommonBuy/2020-01-01/cn-beijing',
      { method: 'POST', credentials: 'include', headers: headers, body: body },
    );
  } catch (e) {
    __volc_setStatus(tag + '网络异常，请稍后重试');
    return { ok: false, retryable: false };
  }
  const data = await res.json();
  const error = data.ResponseMetadata?.Error;
  if (error) {
    const isConfigError = error.Code === 'InvalidParameter.Configuration';
    const isStockError = error.Code === 'TransferError';
    if (isStockError) {
      __volc_setStatus(tag + '当前商品库存不足，暂不可下单');
    } else if (isConfigError) {
      __volc_setStatus(tag + '当前配置暂不可用');
    } else {
      __volc_setStatus(tag + '当前暂不可下单，请稍后重试');
    }
    return { ok: false, retryable: isConfigError, error: error };
  }
  const orderId = data.Result?.CustomerOrderID;
  if (!orderId) {
    __volc_setStatus(tag + '未返回订单信息，请稍后重试');
    return { ok: false, retryable: false };
  }
  __volc_setStatus('订单 ' + orderId + ' 已创建，正在跳转支付…');
  const payUrl = 'https://www.volcengine.com/activity/' + __volc_config.payPath + '?i_f=1&o_n=' +
    encodeURIComponent(orderId) + '&tik=' + encodeURIComponent(indexKey);
  __volc_playBeeps(3);
  __volc_postCmd('VOLC_PURCHASE_SUCCESS', {
    orderId: orderId,
    productId: product.id,
    productName: product.name,
    plan: __volc_config.title,
    payUrl: payUrl,
  });
  window.location.assign(payUrl);
  return { ok: true };
}

async function __volc_createOrder(productId) {
  if (!productId || !__volc_catalogData) return false;
  const all = [].concat(
    __volc_catalogData.groups.monthly,
    __volc_catalogData.groups.quarterly,
    __volc_catalogData.groups.yearly,
  );
  const product = all.find(function (p) { return p.id === productId; });
  if (!product || !product.raw) {
    __volc_setStatus('未找到套餐配置：' + productId);
    return false;
  }

  const raw = product.raw;
  const candidates = raw.indexKeyCandidates && raw.indexKeyCandidates.length
    ? raw.indexKeyCandidates.slice()
    : [raw.indexKey];

  for (let i = 0; i < candidates.length; i++) {
    const result = await __volc_tryOrder(product, candidates[i]);
    if (result.ok) return true;
    if (!result.retryable) return false;
    if (i < candidates.length - 1) {
      __volc_setStatus(__volc_formatProductTag(product) + '当前配置暂不可用，尝试其他索引…');
    }
  }
  return false;
}

// Listen for messages from ISOLATED world.
window.addEventListener('message', function (event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data?.__volc_overlay) return;

  if (data.type === 'VOLC_AUTH_STATUS') {
    __volc_setStatus(data.data?.ok ? '认证就绪' : '未登录');
  }
  if (data.type === 'VOLC_ORDER_RESULT') {
    if (data.error) {
      __volc_setStatus('当前暂不可下单：' + data.error);
    } else if (data.data) {
      __volc_setStatus('订单 ' + data.data.orderId + ' 已创建，正在跳转支付…');
    }
  }
});

// Initial extraction attempts.
(async function () {
  if (!(await __volc_extractAndSend())) {
    let attempts = 0;
    const timer = setInterval(async function () {
      attempts++;
      const ok = await __volc_extractAndSend();
      if (ok || attempts > 10) clearInterval(timer);
    }, 500);
  }
})();

setTimeout(__volc_vh_injectHeader, 800);
setTimeout(__volc_vh_injectHeader, 2500);
