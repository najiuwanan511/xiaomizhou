export function productUrls(text, platformFor) {
  const found = String(text).match(/https?:\/\/[^\s<>"'\u3000]+/gi) || [];
  return [...new Set(found.map(url => url.replace(/[.,!?:;\u3002\uff0c\uff01\uff1f\uff1a\uff1b)\]\u3011]+$/u, '')).filter(url => platformFor(url)))].slice(0, 5);
}

export async function applyRebates(event, result, config, convert, platformFor, log) {
  if (!config.enabled) return result;
  const conversions = [];
  for (const url of productUrls(event.text, platformFor)) {
    try {
      const conversion = await convert({ url });
      conversions.push(conversion);
      if (conversion.mode !== 'live') continue;
      for (const action of result.actions) {
        if (action.type === 'forward' && action.text.includes(url)) action.text = action.text.replaceAll(url, conversion.resultUrl);
      }
      if (config.reply) result.actions.push({ type: 'reply', text: conversion.resultUrl, plugin: 'Affiliate conversion' });
      log('info', 'rebate', `${conversion.platform} automatic conversion`);
    } catch (error) {
      for (const action of result.actions) {
        if (action.type === 'forward' && action.text.includes(url)) {
          action.type = 'blocked';
          action.reason = 'Affiliate conversion failed';
        }
      }
      result.errors.push({ plugin: 'Affiliate conversion', message: error.message });
      log('error', 'rebate', `Automatic conversion: ${error.message}`);
    }
  }
  return { ...result, conversions };
}
