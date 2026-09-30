import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { convertOfficial, signJd, signTaobao } from '../rebate-automation.js';

const date = new Date('2026-09-30T12:34:56Z');

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
  assert.equal(url, 'https://u.jd.com/promo');
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
  assert.equal(url, 'https://u.jd.com/social');
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
      return { ok: true, json: async () => ({ tbk_dg_general_link_convert_response: { data: { material_url_list: { material_url_list: [{ code: 0, link_info_dto: { coupon_short_url: 'https://s.click.taobao.com/coupon', cps_short_url: 'https://s.click.taobao.com/item' } }] } } } }) };
    }
  });
  assert.equal(url, 'https://s.click.taobao.com/coupon');
  assert.equal(signTaobao({ b: '2', a: '1' }, 's'), crypto.createHmac('md5', 's').update('a1b2').digest('hex').toUpperCase());
});

test('official connector rejects permission errors and non-HTTPS results', async () => {
  await assert.rejects(convertOfficial('taobao', 'https://item.taobao.com/a', { appKey: 'key', appSecret: 'secret', adzoneId: '890' }, {
    fetcher: async () => ({ ok: true, json: async () => ({ tbk_dg_general_link_convert_response: { data: { material_url_list: { material_url_list: [{ code: 1001, msg: '无权限', link_info_dto: { cps_short_url: 'https://s.click.taobao.com/not-valid' } }] } } } }) })
  }), /1001.*无权限/);
  await assert.rejects(convertOfficial('jd', 'https://item.jd.com/1.html', { appKey: 'key', appSecret: 'secret', jdMethod: 'site', siteId: '1234' }, {
    fetcher: async () => ({ ok: true, json: async () => ({ jd_union_open_promotion_common_get_response: { result: JSON.stringify({ code: 200, data: { clickURL: 'http://example.com/insecure' } }) } }) })
  }), /no HTTPS promotion URL/);
});
