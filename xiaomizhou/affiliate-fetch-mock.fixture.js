import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  if (String(input) === 'https://api.zhetaoke.com:20001/api/open_jing_union_open_promotion_byunionid_get.ashx') {
    // Fail the route test if a title, sharing instructions or escaped scheme reaches the provider.
    assert.equal(options.body.get('materialId'), 'https://3.cn/35-zYL9p?jkl=@U55sUCWNwMY6@');
    return new Response(JSON.stringify({ status: 200, content: [{ shorturl: 'https://u.jd.com/share-test', title: '测试商品' }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return originalFetch(input, options);
};
