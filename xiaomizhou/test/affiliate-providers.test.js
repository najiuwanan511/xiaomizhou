import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { convertAffiliate, convertOfficial, formatRebate, signJd, signPdd, signTaobao } from '../rebate-automation.js';

const date = new Date('2026-09-30T12:34:56Z');
const ztkConfig = { provider: 'zhetaoke', ztkAppKey: 'ztk-key', unionId: '123456', appKey: 'official-key', appSecret: 'official-secret' };
const mockResponse = payload => async () => ({ ok: true, json: async () => payload });

test('Zhetaoke dispatch uses separate credentials and encodes the product URL once', async () => {
  const source = 'https://item.jd.com/123.html?x=1&coupon=中文';
  const result = await convertAffiliate('jd', source, { ...ztkConfig, ztkPositionId: '12345678901234567890' }, {
    fetcher: async (endpoint, options) => {
      assert.equal(endpoint, 'https://api.zhetaoke.com:20001/api/open_jing_union_open_promotion_byunionid_get.ashx');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body.toString())), {
        appkey: 'ztk-key', unionId: '123456', materialId: source, chainType: '2', signurl: '0', positionId: '12345678901234567890'
      });
      return mockResponse({ jd_union_open_promotion_byunionid_get_response: { code: '0', result: JSON.stringify({ code: 200, data: { shortURL: 'https://u.jd.com/ztk' } }) } })();
    }
  });
  assert.deepEqual(result, { resultUrl: 'https://u.jd.com/ztk' });
});

test('Zhetaoke detail mode maps actual metadata into the existing template and image flow', async () => {
  const result = await convertAffiliate('jd', 'https://item.jd.com/123.html', { ...ztkConfig, ztkDetails: true }, {
    fetcher: async (_endpoint, options) => {
      assert.equal(options.body.get('signurl'), '5');
      assert.equal(options.body.has('positionId'), false);
      return mockResponse({ status: 200, content: [{ title: '测试商品', shorturl: 'https://u.jd.com/ztk', pict_url: 'https://img14.360buyimg.com/test.jpg', tkfee3: '5.07', tkl: '京口令' }] })();
    }
  });
  assert.equal(result.imageUrl, 'https://img14.360buyimg.com/test.jpg');
  assert.equal(result.estimate, 5.07);
  assert.equal(formatRebate({ ...result, mode: 'live' }), '商品：测试商品\n返利链接：https://u.jd.com/ztk\n返利口令：京口令\n预计返利：5.07 元');
  const basic = await convertAffiliate('jd', 'https://item.jd.com/123.html', ztkConfig, {
    fetcher: mockResponse({ status: 200, content: [{ coupon_click_url: 'https://union-click.jd.com/example', pict_url: 'https://127.0.0.1/image', tkfee3: '' }] })
  });
  assert.equal(basic.estimate, undefined);
  assert.equal(basic.imageUrl, undefined);
});

test('Zhetaoke refuses unauthorized, malformed and insecure responses', async () => {
  for (const [payload, pattern] of [
    [{ status: 301, content: '联盟ID未授权' }, /301.*未授权/],
    [{ jd_union_open_promotion_byunionid_get_response: { code: '0', result: '{"code":403,"message":"无访问权限"}' } }, /403.*无访问权限/],
    [{ jd_union_open_promotion_byunionid_get_response: { result: 'bad json' } }, /invalid result JSON/],
    [{ status: 200, content: [{ shorturl: 'http://u.jd.com/unsafe' }] }, /HTTPS/],
    [{ status: 200, content: [] }, /未返回/]
  ]) await assert.rejects(convertAffiliate('jd', 'https://item.jd.com/123.html', ztkConfig, { fetcher: mockResponse(payload) }), pattern);
  await assert.rejects(convertAffiliate('pdd', 'https://mobile.yangkeduo.com/a', ztkConfig), /仅支持京东和淘宝/);
  await assert.rejects(convertAffiliate('jd', 'https://item.jd.com/123.html', { ...ztkConfig, unionId: 'bad' }), /必须为数字/);
});

const ztkTaobaoConfig = { provider: 'zhetaoke', ztkAppKey: 'tb-key', ztkSid: 'sid-123', ztkPid: 'mm_111_222_333', ztkRelationId: '456', appSecret: 'not-sent' };

test('Zhetaoke Taobao sends authorized SID, complete PID and RID and returns metadata', async () => {
  const source = 'https://e.tb.cn/h.example?tk=abc%2Bdef&x=1';
  const result = await convertAffiliate('taobao', source, ztkTaobaoConfig, {
    fetcher: async (endpoint, options) => {
      assert.equal(endpoint, 'https://api.zhetaoke.com:10001/api/open_gaoyongzhuanlian_tkl.ashx');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body.toString())), {
        appkey: 'tb-key', sid: 'sid-123', pid: 'mm_111_222_333', tkl: source, signurl: '5', relation_id: '456'
      });
      return mockResponse({ status: 200, content: [{ shorturl: 'https://s.click.taobao.com/promo', title: '淘宝商品', tkl: '￥newcode￥', pict_url: 'https://img.alicdn.com/item.jpg', tkfee3: '3.20' }] })();
    }
  });
  assert.deepEqual(result, { resultUrl: 'https://s.click.taobao.com/promo', name: '淘宝商品', code: '￥newcode￥', imageUrl: 'https://img.alicdn.com/item.jpg', estimate: 3.2 });
});

test('Zhetaoke Taobao retries item parsing once using the short link token, retaining attribution', async () => {
  const source = '【淘宝】https://e.tb.cn/h.example?tk=Abc123xyZ89「商品」';
  const calls = [];
  const result = await convertAffiliate('taobao', source, ztkTaobaoConfig, {
    fetcher: async (endpoint, options) => {
      assert.equal(endpoint, 'https://api.zhetaoke.com:10001/api/open_gaoyongzhuanlian_tkl.ashx');
      calls.push(options.body.get('tkl'));
      assert.equal(options.body.get('sid'), 'sid-123');
      assert.equal(options.body.get('pid'), 'mm_111_222_333');
      assert.equal(options.body.get('relation_id'), '456');
      assert.equal(options.body.has('jb'), false);
      return mockResponse(calls.length === 1
        ? { status: 301, content: '很抱歉！商品ID解析错误！！！' }
        : { status: 200, content: [{ shorturl: 'https://s.click.taobao.com/promo' }] })();
    }
  });
  assert.deepEqual(calls, [source, '￥Abc123xyZ89￥']);
  assert.equal(result.resultUrl, 'https://s.click.taobao.com/promo');
});

test('Zhetaoke token fallback is bounded and never retries auth errors or ambiguous tokens', async () => {
  for (const [source, payload, expectedCalls] of [
    ['https://e.tb.cn/h.test?tk=Abc123xyZ89', { status: 301, content: '商品ID解析错误' }, 2],
    ['https://e.tb.cn/h.test?tk=Abc123xyZ89', { status: 301, content: '授权失效' }, 1],
    ['https://e.tb.cn/h.test?tk=Abc123xyZ89', { error_response: { code: 15, sub_msg: 'SID失效' } }, 1],
    ['https://e.tb.cn/h.test?tk=bad', { status: 301, content: '商品ID解析错误' }, 1],
    ['https://e.tb.cn.evil.example/h.test?tk=Abc123xyZ89', { status: 301, content: '商品ID解析错误' }, 1],
    ['https://e.tb.cn/h.one?tk=Abc123xyZ89 https://m.tb.cn/h.two?tk=Abc123xyZ88', { status: 301, content: '商品ID解析错误' }, 1]
  ]) {
    let calls = 0;
    await assert.rejects(convertAffiliate('taobao', source, ztkTaobaoConfig, {
      fetcher: async () => { calls++; return mockResponse(payload)(); }
    }), error => {
      if (expectedCalls === 2) assert.match(error.message, /已尝试短链自带的淘口令/);
      return true;
    });
    assert.equal(calls, expectedCalls, source);
  }
});

test('Zhetaoke Taobao retains channel attribution on fallback links and omits unknown commission', async () => {
  const result = await convertAffiliate('taobao', 'https://e.tb.cn/h.example', ztkTaobaoConfig, {
    fetcher: mockResponse({ status: '200', content: [{ item_url: 'https://s.click.taobao.com/t?e=a%2Bb&relationId=old', tkfee3: '' }] })
  });
  const link = new URL(result.resultUrl);
  assert.equal(link.searchParams.get('e'), 'a+b');
  assert.equal(link.searchParams.get('relationId'), '456');
  assert.equal(result.estimate, undefined);
  await convertAffiliate('taobao', 'https://e.tb.cn/h.example', { ...ztkTaobaoConfig, ztkRelationId: '' }, {
    fetcher: async (_endpoint, options) => {
      assert.equal(options.body.has('relation_id'), false);
      return mockResponse({ status: 200, content: [{ coupon_click_url: 'https://uland.taobao.com/coupon/edetail?e=abc', pict_url: 'http://img.alicdn.com/item.jpg', tkfee3: 'bad' }] })();
    }
  }).then(value => { assert.equal(value.resultUrl, 'https://uland.taobao.com/coupon/edetail?e=abc'); assert.equal(value.imageUrl, undefined); assert.equal(value.estimate, undefined); });
});

test('Zhetaoke Taobao rejects incomplete credentials, authorization failures and malformed results', async () => {
  for (const config of [{ ...ztkTaobaoConfig, ztkSid: '' }, { ...ztkTaobaoConfig, ztkPid: '333' }, { ...ztkTaobaoConfig, ztkRelationId: 'bad' }]) {
    await assert.rejects(convertAffiliate('taobao', 'https://e.tb.cn/h.example', config), error => error.status === 400);
  }
  for (const [payload, pattern] of [
    [{ status: 301, content: '授权失效' }, /301.*授权失效/],
    [{ error_response: { code: 15, sub_msg: '宝贝已下架或非淘客宝贝' } }, /15.*已下架/],
    [{ status: 200, content: [] }, /未返回/],
    [null, /未返回/],
    [{ status: 200, content: [{ shorturl: 'http://example.com/a', taobao_url: 'https://item.taobao.com/item.htm?id=1' }] }, /HTTPS/]
  ]) await assert.rejects(convertAffiliate('taobao', 'https://e.tb.cn/h.example', ztkTaobaoConfig, { fetcher: mockResponse(payload) }), pattern);
});

test('Zhetaoke Taobao parses documented basic and simplified flat responses', async () => {
  for (const signurl of ['3', '4']) {
    const result = await convertAffiliate('taobao', 'https://m.tb.cn/h.test', { ...ztkTaobaoConfig, ztkTaobaoSignurl: signurl }, {
      fetcher: async (_endpoint, options) => {
        assert.equal(options.body.get('signurl'), signurl);
        return mockResponse({ item_url: 'https://s.click.taobao.com/t?e=x%2By', ...(signurl === '4' ? { title: '简版商品', tkl: '￥abc123￥', pict_url: 'https://img.alicdn.com/a.jpg' } : {}) })();
      }
    });
    assert.equal(new URL(result.resultUrl).searchParams.get('relationId'), '456');
    assert.equal(result.estimate, undefined, 'a commission rate must not be reported as a commission amount');
    assert.equal(result.code, signurl === '4' ? '￥abc123￥' : '');
  }
  await assert.rejects(convertAffiliate('taobao', 'https://m.tb.cn/h.test', { ...ztkTaobaoConfig, ztkTaobaoSignurl: '1' }), /结果类型/);
  await assert.rejects(convertAffiliate('taobao', 'https://m.tb.cn/h.test', { ...ztkTaobaoConfig, ztkTaobaoSignurl: '3' }, {
    fetcher: mockResponse({ status: 403, msg: '权限不足', item_url: 'https://s.click.taobao.com/t?e=x' })
  }), /403.*权限不足/);
});

test('Zhetaoke Taobao errors distinguish network, malformed data and upstream subcodes', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('aborted'), { name: 'TimeoutError' }), /超时.*20 秒/],
    [new SyntaxError('Unexpected token <'), /不是有效 JSON/],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /ECONNREFUSED.*10001/]
  ]) await assert.rejects(convertAffiliate('taobao', 'https://m.tb.cn/h.test', ztkTaobaoConfig, { fetcher: async () => { throw error; } }), expected);
  await assert.rejects(convertAffiliate('taobao', 'https://m.tb.cn/h.test', ztkTaobaoConfig, {
    fetcher: mockResponse({ error_response: { code: 15, sub_code: 'isv.item-not-exist', sub_msg: '商品不可推广' } })
  }), /isv.item-not-exist.*商品不可推广/);
  await assert.rejects(convertAffiliate('taobao', 'https://m.tb.cn/h.test', ztkTaobaoConfig, {
    fetcher: mockResponse({ status: 403, content: { message: 'SID授权失效' } })
  }), /403.*SID授权失效/);
});

test('JD accepts getResult envelopes and short-only links without accepting failed wrappers', async () => {
  const payload = { jd_union_open_promotion_bysubunionid_get_responce: { code: '0', getResult: JSON.stringify({ code: 200, data: { shortURL: 'https://u.jd.com/short' } }) } };
  assert.deepEqual(await convertAffiliate('jd', 'https://item.jd.com/1.html', { provider: 'official', appKey: 'key', appSecret: 'secret' }, { fetcher: mockResponse(payload) }), { resultUrl: 'https://u.jd.com/short' });
  payload.jd_union_open_promotion_bysubunionid_get_responce.code = '403';
  await assert.rejects(convertOfficial('jd', 'https://item.jd.com/1.html', { appKey: 'key', appSecret: 'secret' }, { fetcher: mockResponse(payload) }), /JD API 403/);
});

test('official JD connector signs the request and parses the promotion link', async () => {
  const source = 'https://item.jd.com/123.html';
  const url = await convertOfficial('jd', source, { appKey: 'key', appSecret: 'secret', jdMethod: 'site', siteId: '1234', positionId: '5678' }, {
    date,
    fetcher: async (endpoint, options) => {
      assert.equal(endpoint, 'https://router.jd.com/api');
      const params = Object.fromEntries(options.body);
      const { sign, ...unsigned } = params;
      assert.equal(sign, signJd(unsigned, 'secret'));
      assert.equal(params.timestamp, '2026-09-30 20:34:56');
      assert.deepEqual(JSON.parse(params.param_json), { promotionCodeReq: { materialId: source, siteId: '1234', positionId: 5678 } });
      return { ok: true, json: async () => ({ jd_union_open_promotion_common_get_response: { code: '0', result: JSON.stringify({ code: 200, data: { clickURL: 'https://u.jd.com/promo' } }) } }) };
    }
  });
  assert.deepEqual(url, { resultUrl: 'https://u.jd.com/promo' });
  assert.equal(signJd({ b: '2', a: '1' }, 's'), crypto.createHash('md5').update('sa1b2s').digest('hex').toUpperCase());
});

test('official JD social connector uses the social API without a site ID', async () => {
  const url = await convertOfficial('jd', 'https://item.jd.com/123.html', { appKey: 'key', appSecret: 'secret' }, {
    fetcher: async (_endpoint, options) => {
      const fields = Object.fromEntries(options.body);
      assert.equal(fields.method, 'jd.union.open.promotion.bysubunionid.get');
      assert.deepEqual(JSON.parse(fields.param_json), { promotionCodeReq: { materialId: 'https://item.jd.com/123.html' } });
      return { ok: true, json: async () => ({ jd_union_open_promotion_bysubunionid_get_response: { code: '0', result: JSON.stringify({ code: 200, data: { clickURL: 'https://u.jd.com/social' } }) } }) };
    }
  });
  assert.deepEqual(url, { resultUrl: 'https://u.jd.com/social' });
});

test('official Taobao connector signs the request and prefers the coupon link', async () => {
  const url = await convertOfficial('taobao', 'https://item.taobao.com/item.htm?id=123', { appKey: 'key', appSecret: 'secret', adzoneId: '890' }, {
    date,
    fetcher: async (endpoint, options) => {
      assert.equal(endpoint, 'https://eco.taobao.com/router/rest');
      const params = Object.fromEntries(options.body);
      const { sign, ...unsigned } = params;
      assert.equal(sign, signTaobao(unsigned, 'secret'));
      assert.equal(params.adzone_id, '890');
      assert.match(params.required_link_type, /coupon_short_tpwd/);
      return { ok: true, json: async () => ({ tbk_dg_general_link_convert_response: { data: { material_url_list: { material_url_list: [{ code: 0, link_info_dto: { coupon_short_url: 'https://s.click.taobao.com/coupon', cps_short_url: 'https://s.click.taobao.com/item', coupon_short_tpwd: '￥coupon￥' } }] } } } }) };
    }
  });
  assert.deepEqual(url, { resultUrl: 'https://s.click.taobao.com/coupon', code: '￥coupon￥' });
  assert.equal(signTaobao({ b: '2', a: '1' }, 's'), crypto.createHmac('md5', 's').update('a1b2').digest('hex').toUpperCase());
});

test('official Pinduoduo connector signs the source URL and parses the promotion link', async () => {
  const source = 'https://mobile.yangkeduo.com/goods.html?goods_id=123';
  const result = await convertOfficial('pdd', source, { clientId: 'client-id', clientSecret: 'secret', pid: '123_456' }, {
    date,
    fetcher: async (endpoint, options) => {
      assert.equal(endpoint, 'https://gw-api.pinduoduo.com/api/router');
      const params = Object.fromEntries(options.body);
      const { sign, ...unsigned } = params;
      assert.equal(sign, signPdd(unsigned, 'secret'));
      assert.equal(params.type, 'pdd.ddk.goods.zs.unit.url.gen');
      assert.equal(params.source_url, source);
      assert.equal(params.pid, '123_456');
      assert.equal(params.timestamp, String(Math.floor(date.getTime() / 1000)));
      return { ok: true, json: async () => ({ goods_zs_unit_generate_response: { mobile_short_url: 'https://p.pinduoduo.com/promo' } }) };
    }
  });
  assert.deepEqual(result, { resultUrl: 'https://p.pinduoduo.com/promo' });
  assert.equal(signPdd({ b: '2', a: '1' }, 's'), crypto.createHash('md5').update('sa1b2s').digest('hex').toUpperCase());
});

test('official connector rejects permission errors and non-HTTPS results', async () => {
  await assert.rejects(convertOfficial('taobao', 'https://item.taobao.com/a', { appKey: 'key', appSecret: 'secret', adzoneId: '890' }, {
    fetcher: async () => ({ ok: true, json: async () => ({ tbk_dg_general_link_convert_response: { data: { material_url_list: { material_url_list: [{ code: 1001, msg: '无权限', link_info_dto: { cps_short_url: 'https://s.click.taobao.com/not-valid' } }] } } } }) })
  }), /1001.*无权限/);
  await assert.rejects(convertOfficial('jd', 'https://item.jd.com/1.html', { appKey: 'key', appSecret: 'secret', jdMethod: 'site', siteId: '1234' }, {
    fetcher: async () => ({ ok: true, json: async () => ({ jd_union_open_promotion_common_get_response: { result: JSON.stringify({ code: 200, data: { clickURL: 'http://example.com/insecure' } }) } }) })
  }), /no HTTPS promotion URL/);
  await assert.rejects(convertOfficial('pdd', 'https://mobile.yangkeduo.com/goods.html?goods_id=123', { clientId: 'id', clientSecret: 'secret', pid: '1_2' }, {
    fetcher: async () => ({ ok: true, json: async () => ({ goods_zs_unit_generate_response: { url: 'http://example.com/insecure' } }) })
  }), /no HTTPS promotion URL/);
});
