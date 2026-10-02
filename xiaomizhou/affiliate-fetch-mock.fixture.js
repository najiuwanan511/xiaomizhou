import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  if (String(input) === 'https://api.openai.com/v1/responses') {
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: `模拟AI:${request.input.at(-1).content}` }] }] }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (String(input) === 'https://api.zhetaoke.com:10001/api/open_gaoyongzhuanlian_tkl.ashx') {
    if (options.body.get('sid') === 'expired-test-sid') return new Response(JSON.stringify({ error_response: { code: 15, sub_code: 'invalid-sessionkey', sub_msg: `SID授权失效 ${options.body.get('appkey')}` } }), { headers: { 'Content-Type': 'application/json' } });
    const sources = ['https://e.tb.cn/h.test?tk=abc%2Bdef&x=1', 'https://m.tb.cn/h.test', 'https://detail.tmall.com/item.htm?id=123'];
    const fullShare = '【淘宝】https://m.tb.cn/h.needs-token「测试商品」\n￥Abc123xyZ89￥ 复制整段打开淘宝';
    if (options.body.get('tkl') === 'https://m.tb.cn/h.needs-token') return Response.json({ status: 301, content: '商品ID解析错误' });
    const allowed = [...sources, ...sources.map(url => `【淘宝】${url}「测试商品」\n点击链接直接打开 或者 淘宝搜索直接打开`), '【淘宝】https://m.tb.cn/h.test「测试商品」', fullShare];
    assert.ok(allowed.includes(options.body.get('tkl')), 'unexpected or truncated Taobao share text');
    assert.equal(options.body.get('sid'), 'tb-sid');
    assert.equal(options.body.get('pid'), 'mm_111_222_333');
    assert.equal(options.body.get('relation_id'), '456');
    if (options.body.get('signurl') === '3') return new Response(JSON.stringify({ item_url: 'https://s.click.taobao.com/t?e=basic' }), { headers: { 'Content-Type': 'application/json' } });
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
