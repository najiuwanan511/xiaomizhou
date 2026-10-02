import crypto from 'node:crypto';
import net from 'node:net';


const jdEndpoint = 'https://router.jd.com/api';
const taobaoEndpoint = 'https://eco.taobao.com/router/rest';
export const defaultRebateTemplate = '商品：{{name}}\n返利链接：{{url}}\n返利口令：{{code}}\n预计返利：{{estimate}}';

export function validateRebateTemplate(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || value.split('\n').length > 20) {
    throw Object.assign(new Error('Template must be 1-1000 characters and at most 20 lines'), { status: 400 });
  }
  const fields = [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1]);
  if (fields.some(field => !['name', 'url', 'code', 'estimate'].includes(field)) || !fields.includes('url') || /{{|}}/.test(value.replace(/{{\s*(?:name|url|code|estimate)\s*}}/g, ''))) {
    throw Object.assign(new Error('Template needs {{url}} and only supports {{name}}, {{url}}, {{code}}, {{estimate}}'), { status: 400 });
  }
  return value;
}

function cleanField(value, maxLength = 200) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

export function formatRebate(conversion, template = defaultRebateTemplate) {
  if (conversion.mode !== 'live') return '';
  const fields = {
    name: cleanField(conversion.name),
    url: conversion.resultUrl,
    code: cleanField(conversion.code),
    estimate: typeof conversion.estimate === 'number' && Number.isFinite(conversion.estimate) && conversion.estimate >= 0
      ? `${conversion.estimate.toFixed(2)} 元` : cleanField(conversion.estimate, 80)
  };
  const rendered = template.split(/\r?\n/).filter(line =>
    ![...line.matchAll(/{{\s*(name|code|estimate)\s*}}/g)].some(match => !fields[match[1]])
  ).map(line => line.replace(/{{\s*(name|url|code|estimate)\s*}}/g, (_match, field) => fields[field])).join('\n').trim();
  return rendered.includes(fields.url) ? rendered : [rendered, `返利链接：${fields.url}`].filter(Boolean).join('\n');
}

function timestamp(date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(date);
}

function sortedFields(fields) {
  return Object.keys(fields).sort().map(key => `${key}${fields[key]}`).join('');
}

export function signJd(fields, secret) {
  return crypto.createHash('md5').update(`${secret}${sortedFields(fields)}${secret}`, 'utf8').digest('hex').toUpperCase();
}

export function signTaobao(fields, secret) {
  return crypto.createHmac('md5', secret).update(sortedFields(fields), 'utf8').digest('hex').toUpperCase();
}

function required(config, fields) {
  for (const [field, label] of fields) {
    if (!String(config[field] || '').trim()) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  }
}

function httpsUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname ? url.href : null; }
  catch { return null; }
}

export function imageUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2000) return null;
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && host && !url.username && !url.password && !url.port && host !== 'localhost' && !host.endsWith('.localhost') && !net.isIP(host) ? url.href : null;
  } catch { return null; }
}

async function postForm(endpoint, fields, fetcher) {
  const response = await fetcher(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams(fields), signal: AbortSignal.timeout(10000), redirect: 'error'
  });
  if (!response.ok) throw new Error(`Affiliate API returned HTTP ${response.status}`);
  return response.json();
}

function jdResult(payload, method) {
  if (payload.error_response) throw new Error(`JD API ${payload.error_response.code || 'error'}: ${payload.error_response.zh_desc || payload.error_response.en_desc || 'request failed'}`);
  const wrapper = payload[method.replaceAll('.', '_') + '_response'];
  if (!wrapper) throw new Error('JD API returned an unexpected response');
  let result;
  try { result = typeof wrapper.result === 'string' ? JSON.parse(wrapper.result) : wrapper.result; }
  catch { throw new Error('JD API returned invalid result JSON'); }
  if ((wrapper.code != null && String(wrapper.code) !== '0') || String(result?.code) !== '200') throw new Error(`JD API ${result?.code || wrapper.code || 'error'}: ${result?.message || wrapper.message || 'conversion failed'}`);
  const url = httpsUrl(result?.data?.clickURL);
  if (!url) throw new Error('JD API returned no HTTPS promotion URL');
  const picture = imageUrl(result?.data?.imageUrl || result?.data?.imgUrl);
  return { resultUrl: url, ...(picture ? { imageUrl: picture } : {}) };
}

function taobaoResult(payload) {
  if (payload.error_response) throw new Error(`Taobao API ${payload.error_response.code || 'error'}: ${payload.error_response.sub_msg || payload.error_response.msg || 'request failed'}`);
  const data = payload.tbk_dg_general_link_convert_response?.data;
  const items = data?.material_url_list?.material_url_list;
  const item = Array.isArray(items) ? items[0] : items;
  if (!item) throw new Error('Taobao API returned no converted material');
  if (item.code != null && String(item.code) !== '0') throw new Error(`Taobao API ${item.code}: ${item.msg || 'conversion failed'}`);
  const links = item.link_info_dto;
  const couponUrl = httpsUrl(links?.coupon_short_url) || httpsUrl(links?.coupon_long_url);
  const cpsUrl = httpsUrl(links?.cps_short_url) || httpsUrl(links?.cps_long_url);
  if (!couponUrl && !cpsUrl) throw new Error('Taobao API returned no HTTPS promotion URL');
  const conversion = couponUrl
    ? { resultUrl: couponUrl, code: links?.coupon_short_tpwd || '' }
    : { resultUrl: cpsUrl, code: links?.cps_short_tpwd || '' };
  const picture = imageUrl(item.imageUrl || item.imgUrl);
  return picture ? { ...conversion, imageUrl: picture } : conversion;
}

export async function convertOfficial(platform, url, config, { fetcher = fetch, date = new Date() } = {}) {
  if (platform === 'jd') {
    required(config, [['appKey', 'JD AppKey'], ['appSecret', 'JD AppSecret']]);
    const site = config.jdMethod === 'site';
    if (site && !/^\d+$/.test(config.siteId || '')) throw Object.assign(new Error('JD site ID must be numeric'), { status: 400 });
    const method = site ? 'jd.union.open.promotion.common.get' : 'jd.union.open.promotion.bysubunionid.get';
    if (config.positionId && (!/^\d+$/.test(config.positionId) || !Number.isSafeInteger(Number(config.positionId)))) throw Object.assign(new Error('JD position ID must be a safe integer'), { status: 400 });
    const request = { materialId: url, ...(site ? { siteId: config.siteId } : {}), ...(config.positionId ? { positionId: Number(config.positionId) } : {}) };
    const fields = {
      app_key: config.appKey, method, format: 'json',
      sign_method: 'md5', timestamp: timestamp(date), v: '1.0',
      param_json: JSON.stringify({ promotionCodeReq: request })
    };
    fields.sign = signJd(fields, config.appSecret);
    return jdResult(await postForm(jdEndpoint, fields, fetcher), method);
  }
  if (platform === 'taobao') {
    required(config, [['appKey', 'Taobao AppKey'], ['appSecret', 'Taobao AppSecret'], ['adzoneId', 'Taobao adzone ID']]);
    if (!/^\d+$/.test(config.adzoneId)) throw Object.assign(new Error('Taobao adzone ID must be numeric'), { status: 400 });
    const fields = {
      app_key: config.appKey, method: 'taobao.tbk.dg.general.link.convert', format: 'json',
      sign_method: 'hmac', timestamp: timestamp(date), v: '2.0', adzone_id: config.adzoneId,
      material_list: url, required_link_type: 'coupon_short_url,coupon_long_url,cps_short_url,cps_long_url,coupon_short_tpwd,cps_short_tpwd'
    };
    fields.sign = signTaobao(fields, config.appSecret);
    return taobaoResult(await postForm(taobaoEndpoint, fields, fetcher));
  }
  throw Object.assign(new Error('Official connector is unavailable for this platform'), { status: 400 });
}

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
      const message = formatRebate(conversion, config.template);
      const picture = config.image && imageUrl(conversion.imageUrl);
      const images = picture ? [{ url: picture }] : [];
      for (const action of result.actions) {
        if (action.type === 'forward' && action.text.includes(url)) {
          action.text = action.text.replaceAll(url, message);
          if (images.length) action.images = [...(action.images || []), ...images];
        }
      }
      if (config.reply) result.actions.push({ type: 'reply', text: message, ...(images.length ? { images } : {}), plugin: 'Affiliate conversion' });
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
