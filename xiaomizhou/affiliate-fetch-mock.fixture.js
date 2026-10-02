import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  if (String(input) === 'https://api.openai.com/v1/responses') {
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: `模拟AI:${request.input.at(-1).content}` }] }] }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (String(input) === 'https://api.zhetaoke.com:10001/api/open_gaoyongzhuanlian_tkl.ashx') {
    assert.ok(['https://e.tb.cn/h.test?tk=abc%2Bdef&x=1', 'https://m.tb.cn/h.test', 'https://detail.tmall.com/item.htm?id=123'].includes(options.body.get('tkl')));
    assert.equal(options.body.get('sid'), 'tb-sid');
    assert.equal(options.body.get('pid'), 'mm_111_222_333');
    assert.equal(options.body.get('relation_id'), '456');
    return new Response(JSON.stringify({ status: 200, content: [{ shorturl: 'https://s.click.taobao.com/share-test', title: '淘宝测试商品', tkl: '￥newcode￥', pict_url: 'https://img.alicdn.com/item.jpg', tkfee3: '3.20' }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  if (String(input) === 'https://api.zhetaoke.com:20001/api/open_jing_union_open_promotion_byunionid_get.ashx') {
    // Fail the route test if a title, sharing instructions or escaped scheme reaches the provider.
    assert.equal(options.body.get('materialId'), 'https://3.cn/35-zYL9p?jkl=@U55sUCWNwMY6@');
    return new Response(JSON.stringify({ status: 200, content: [{ shorturl: 'https://u.jd.com/share-test', title: '测试商品' }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return originalFetch(input, options);
};
