// Build the platform-agnostic product catalog from the parsed bundle + dynamic prices.

function __volc_buildCatalog(items, prices) {
  const groups = { monthly: [], quarterly: [], yearly: [] };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const b = item.configBody;
    const code = b.ConfigurationCode;
    const duration = b.Duration || 1;
    const billing = __volc_durationToBillingPeriod(duration, b.DurationUnit);
    const priceKey = code + '|' + duration;
    const price = prices[priceKey] || { original: 0, current: 0 };
    const id = code + '|duration:' + duration;

    groups[billing].push({
      id,
      name: __volc_config.displayNames[code] || code,
      billingPeriod: billing,
      price: price.current,
      currentAmount: price.current,
      renewAmount: price.current,
      originalPrice: price.original,
      soldOut: false,
      tag: price.current > 0 && price.current < price.original ? '限时特惠' : '',
      description: duration + '个月 · ' + __volc_billingLabel(duration),
      raw: item,
    });
  }

  for (const k of Object.keys(groups)) {
    groups[k].sort(function (a, b) { return a.currentAmount - b.currentAmount; });
  }

  return {
    platform: __volc_config.platform,
    updatedAt: Date.now(),
    groups,
  };
}
