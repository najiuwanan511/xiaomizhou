import crypto from 'node:crypto';
import net from 'node:net';


const jdEndpoint = 'https://router.jd.com/api';
const taobaoEndpoint = 'https://eco.taobao.com/router/rest';
const pddEndpoint = 'https://gw-api.pinduoduo.com/api/router';
const zhetaokeEndpoint = 'https://api.zhetaoke.com:20001/api/open_jing_union_open_promotion_byunionid_get.ashx';
const zhetaokeTaobaoEndpoint = 'https://api.zhetaoke.com:10001/api/open_gaoyongzhuanlian_tkl.ashx';
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

export function signPdd(fields, secret) {
  return crypto.createHash('md5').update(`${secret}${sortedFields(fields)}${secret}`, 'utf8').digest('hex').toUpperCase();
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

async function postForm(endpoint, fields, fetcher, timeoutMs = 10000) {
  const response = await fetcher(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams(fields), signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
  });
  if (!response.ok) throw new Error(`Affiliate API returned HTTP ${response.status}`);
  return response.json();
}

function jdResult(payload, method) {
  if (payload.error_response) throw new Error(`JD API ${payload.error_response.code || 'error'}: ${payload.error_response.zh_desc || payload.error_response.en_desc || 'request failed'}`);
  const name = method.replaceAll('.', '_');
  const wrapper = payload[name + '_response'] || payload[name + '_responce'];
  if (!wrapper) throw new Error('JD API returned an unexpected response');
  let result;
  const raw = wrapper.getResult ?? wrapper.result;
  try { result = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new Error('JD API returned invalid result JSON'); }
  if (wrapper.code != null && String(wrapper.code) !== '0') throw new Error(`JD API ${wrapper.code}: ${wrapper.message || 'request failed'}`);
  if (String(result?.code) !== '200') throw new Error(`JD API ${result?.code || 'error'}: ${result?.message || 'conversion failed'}`);
  const url = httpsUrl(result?.data?.shortURL) || httpsUrl(result?.data?.clickURL);
  if (!url) throw new Error('JD API returned no HTTPS promotion URL');
  const picture = imageUrl(result?.data?.imageUrl || result?.data?.imgUrl);
  return { resultUrl: url, ...(picture ? { imageUrl: picture } : {}) };
}

export function rebateConfigured(platform, config) {
  return config.mode === 'live' && (config.provider === 'official' || (['jd', 'taobao'].includes(platform) && config.provider === 'zhetaoke'));
}

export async function convertAffiliate(platform, url, config, options = {}) {
  if (config.provider !== 'zhetaoke') return convertOfficial(platform, url, config, options);
  if (platform === 'taobao') return convertZhetaokeTaobao(url, config, options);
  if (platform !== 'jd') throw Object.assign(new Error('折淘客接入目前仅支持京东和淘宝'), { status: 400 });
  required(config, [['ztkAppKey', '折京客 AppKey'], ['unionId', '京东联盟 ID']]);
  if (!/^\d+$/.test(config.unionId) || (config.ztkPositionId && !/^\d+$/.test(config.ztkPositionId))) {
    throw Object.assign(new Error('京东联盟 ID 和折京客推广位必须为数字'), { status: 400 });
  }
  const payload = await postForm(zhetaokeEndpoint, {
    appkey: config.ztkAppKey, unionId: config.unionId, materialId: url,
    chainType: '2', signurl: config.ztkDetails ? '5' : '0',
    ...(config.ztkPositionId ? { positionId: config.ztkPositionId } : {})
  }, options.fetcher || fetch);
  if (payload.status != null && String(payload.status) !== '200') {
    const message = typeof payload.content === 'string' ? payload.content : payload.msg || payload.message || '转链失败';
    throw new Error(`折京客 ${payload.status}: ${message}；请核对折京客 AppKey、联盟 ID 授权和接口权限。`);
  }
  if (payload.jd_union_open_promotion_byunionid_get_response || payload.jd_union_open_promotion_byunionid_get_responce || payload.error_response) {
    try { return jdResult(payload, 'jd.union.open.promotion.byunionid.get'); }
    catch (error) { throw new Error(`折京客：${error.message}；请检查京东账号授权状态。`); }
  }
  const item = Array.isArray(payload.content) ? payload.content[0] : null;
  const resultUrl = httpsUrl(item?.shorturl) || httpsUrl(item?.coupon_click_url);
  if (String(payload.status) !== '200' || !resultUrl) throw new Error('折京客未返回有效的 HTTPS 推广链接；可关闭商品详情选项后重试基础转链。');
  const picture = imageUrl(item.pict_url);
  const estimate = item.tkfee3 != null && String(item.tkfee3).trim() !== '' ? Number(item.tkfee3) : NaN;
  return {
    resultUrl, name: cleanField(item.title || item.tao_title), code: cleanField(item.tkl),
    ...(Number.isFinite(estimate) && estimate >= 0 ? { estimate } : {}),
    ...(picture ? { imageUrl: picture } : {})
  };
}

function taobaoFailureMessage(payload) {
  return typeof payload?.content === 'string' ? payload.content : payload?.content?.msg || payload?.content?.message || payload?.msg || payload?.message || '转链失败';
}

function taobaoParseFailure(payload) {
  return payload?.status != null && String(payload.status) !== '200' && /商品\s*ID\s*解析错误/i.test(taobaoFailureMessage(payload));
}

function shortLinkToken(text) {
  const urls = productUrls(text, value => {
    try { const link = new URL(value); return ['e.tb.cn', 'm.tb.cn'].includes(link.hostname) && !link.username && !link.password && !link.port; }
    catch { return false; }
  });
  if (urls.length !== 1) return null;
  const token = new URL(urls[0]).searchParams.get('tk');
  return /^[a-zA-Z0-9]{11}$/.test(token || '') ? `￥${token}￥` : null;
}

async function convertZhetaokeTaobao(url, config, { fetcher = fetch } = {}) {
  required(config, [['ztkAppKey', '折淘客 AppKey'], ['ztkSid', '折淘客授权 SID'], ['ztkPid', '淘宝完整 PID']]);
  if (!/^mm_\d+_\d+_\d+$/.test(config.ztkPid)) throw Object.assign(new Error('淘宝 PID 须为完整的 mm_数字_数字_数字 格式'), { status: 400 });
  if (config.ztkRelationId && !/^\d+$/.test(config.ztkRelationId)) throw Object.assign(new Error('渠道关系 ID（RID）须为数字'), { status: 400 });
  const signurl = String(config.ztkTaobaoSignurl ?? '5');
  if (!['3', '4', '5'].includes(signurl)) throw Object.assign(new Error('折淘客转链结果类型须为 3、4 或 5'), { status: 400 });
  let payload;
  let retriedToken = false;
  try {
    const fields = {
      appkey: config.ztkAppKey, sid: config.ztkSid, pid: config.ztkPid,
      tkl: url, signurl, ...(config.ztkRelationId ? { relation_id: config.ztkRelationId } : {})
    };
    // Bound both attempts to one request budget. Never retry authorization errors.
    const deadline = Date.now() + 20000;
    payload = await postForm(zhetaokeTaobaoEndpoint, fields, fetcher, 20000);
    const token = taobaoParseFailure(payload) && shortLinkToken(url);
    if (token && Date.now() < deadline) {
      retriedToken = true;
      payload = await postForm(zhetaokeTaobaoEndpoint, { ...fields, tkl: token }, fetcher, Math.max(1, deadline - Date.now()));
    }
  } catch (error) {
    const code = error.cause?.code || error.code || error.name;
    if (/timeout|abort|ETIMEDOUT/i.test(code)) throw new Error('折淘客请求超时（20 秒）；请检查飞牛容器到 api.zhetaoke.com:10001 的网络。可切换基础转链后重试。');
    if (error instanceof SyntaxError) throw new Error('折淘客返回的不是有效 JSON；请检查接口调用日志和网络代理，确认未返回登录页或拦截页。');
    const detail = cleanField(code, 80);
    throw new Error(`折淘客连接失败（${detail}）：${cleanField(error.message, 160)}；请检查 api.zhetaoke.com:10001 的网络、TLS 和代理。`);
  }
  if (payload?.error_response) {
    const error = payload.error_response;
    throw new Error(`折淘客 ${error.code || 'error'} ${cleanField(error.sub_code)}: ${cleanField(error.sub_msg || error.msg || '转链失败', 500)}`);
  }
  if (payload?.status != null && String(payload.status) !== '200') {
    const message = taobaoFailureMessage(payload);
    const channelHint = config.ztkRelationId
      ? '当前请求包含 RID；若相同分享文案留空 RID 能成功，请检查 RID 与渠道 PID、授权账号的匹配。可手动留空验证普通转链，但不代表渠道用户归因通过。'
      : '';
    const hint = taobaoParseFailure(payload)
      ? `${retriedToken ? '已尝试短链自带的淘口令，仍未解析成功。' : ''}${channelHint}请重新复制完整商品分享文案，并在折淘客「接口在线测试」用相同参数对照；若同样失败，请在折淘客检查授权、渠道匹配和商品支持情况。此错误不能单独证明授权过期或 RID 填错。`
      : '请在折淘客接口调用日志查看原因；授权错误需核对淘宝 AppKey、同账号 SID/PID，以及手淘分享所需的代理授权和 RID。';
    throw new Error(`折淘客 ${payload.status}: ${cleanField(message, 400)}；${hint}`);
  }
  // signurl=5 wraps details in content[], while documented 3/4 responses are flat.
  const item = String(payload?.status) === '200'
    ? (Array.isArray(payload.content) ? payload.content[0] : payload.content)
    : payload?.status == null && ['3', '4'].includes(signurl) ? payload : null;
  if (!item || typeof item !== 'object') throw new Error('折淘客未返回商品转链结果；请在折淘客接口在线测试中核对同一组参数和结果类型。');
  let resultUrl = httpsUrl(item.shorturl) || httpsUrl(item.coupon_click_url);
  if (!resultUrl) {
    resultUrl = httpsUrl(item.item_url);
    // The provider documents relationId as required on the item_url fallback.
    if (resultUrl && config.ztkRelationId) {
      const link = new URL(resultUrl);
      link.searchParams.set('relationId', config.ztkRelationId);
      resultUrl = link.href;
    }
  }
  if (!resultUrl) throw new Error('折淘客未返回有效的 HTTPS 推广链接');
  const picture = imageUrl(item.pict_url);
  const estimate = item.tkfee3 != null && String(item.tkfee3).trim() !== '' ? Number(item.tkfee3) : NaN;
  return {
    resultUrl, name: cleanField(item.title || item.tao_title), code: cleanField(item.tkl),
    ...(Number.isFinite(estimate) && estimate >= 0 ? { estimate } : {}),
    ...(picture ? { imageUrl: picture } : {})
  };
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
  if (platform === 'pdd') {
    required(config, [['clientId', 'Pinduoduo Client ID'], ['clientSecret', 'Pinduoduo Client Secret'], ['pid', 'Pinduoduo PID']]);
    const fields = {
      client_id: config.clientId, type: 'pdd.ddk.goods.zs.unit.url.gen',
      timestamp: String(Math.floor(date.getTime() / 1000)),
      source_url: url, pid: config.pid
    };
    fields.sign = signPdd(fields, config.clientSecret);
    const payload = await postForm(pddEndpoint, fields, fetcher);
    if (payload.error_response) throw new Error(`Pinduoduo API ${payload.error_response.error_code || 'error'}: ${payload.error_response.error_msg || 'request failed'}`);
    const data = payload.goods_zs_unit_generate_response;
    const resultUrl = httpsUrl(data?.mobile_short_url) || httpsUrl(data?.mobile_url) || httpsUrl(data?.short_url) || httpsUrl(data?.url);
    if (!resultUrl) throw new Error('Pinduoduo API returned no HTTPS promotion URL');
    return { resultUrl };
  }
  throw Object.assign(new Error('Official connector is unavailable for this platform'), { status: 400 });
}

export function normalizeShareText(text) {
  // Some copied Markdown escapes the colon or slashes in the URL scheme.
  return String(text).replace(/https?\\?:\\?\/\\?\//gi, scheme => scheme.replaceAll('\\', ''));
}

export function productUrls(text, platformFor) {
  const found = normalizeShareText(text).match(/https?:\/\/[^\s<>"'\\\u3000【】「」『』“”‘’（）]+/gi) || [];
  return [...new Set(found.map(url => url.replace(/[.,!?:;\u3002\uff0c\uff01\uff1f\uff1a\uff1b)\]\u3011]+$/u, '')).filter(url => platformFor(url)))].slice(0, 5);
}

export async function applyRebates(event, result, config, convert, platformFor, log) {
  if (!config.enabled) return result;
  const conversions = [];
  const urls = productUrls(event.text, platformFor);
  for (const url of urls) {
    try {
      // A mixed message must never send another product's token to the provider.
      const source = urls.length === 1 && platformFor(url) === 'taobao' ? normalizeShareText(event.text).trim() : url;
      const conversion = await convert({ url: source });
      conversions.push(conversion);
      if (conversion.mode !== 'live') continue;
      const message = formatRebate(conversion, config.template);
      const picture = config.image && imageUrl(conversion.imageUrl);
      const images = picture ? [{ url: picture }] : [];
      for (const action of result.actions) {
        if (action.type === 'forward' && normalizeShareText(action.text).includes(url)) {
          action.text = normalizeShareText(action.text).replaceAll(url, message);
          if (images.length) action.images = [...(action.images || []), ...images];
        }
      }
      if (config.reply) result.actions.push({ type: 'reply', text: message, ...(images.length ? { images } : {}), plugin: 'Affiliate conversion' });
      log('info', 'rebate', `${conversion.platform} automatic conversion`);
    } catch (error) {
      for (const action of result.actions) {
        if (action.type === 'forward' && normalizeShareText(action.text).includes(url)) {
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
