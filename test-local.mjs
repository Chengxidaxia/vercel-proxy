// 本地自测：node test-local.mjs（不联网，mock fetch）
import { PassThrough } from 'node:stream';

process.env.PROXY_DOMAIN = '';
delete process.env.EDGE_CONFIG;

const calls = [];
function mockFetch(fn) { globalThis.fetch = fn; }

function makeRes() {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const headers = {};
  const res = out;
  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => headers[k.toLowerCase()];
  res.removeHeader = (k) => { delete headers[k.toLowerCase()]; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.end(b); return res; };
  res._text = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

function makeReq({ path = '', url = '/', method = 'GET', headers = {} } = {}) {
  return { query: { path }, url, method, headers: Object.assign({ host: 'mirror.test' }, headers) };
}

const { default: handler } = await import('./api/proxy.js');

async function run(name, opt, expect) {
  const r = makeRes();
  mockFetch(async (u, init) => {
    const rec = { u, init };
    calls.push(rec);
    globalThis.__last = rec;
    return new Response('<html><head></head><body>ok</body></html>', {
      status: opt.status || 200,
      headers: Object.assign({ 'content-type': 'text/html; charset=utf-8' }, opt.resHeaders || {}),
    });
  });
  await handler(makeReq(opt), r);
  await new Promise((res) => setTimeout(res, 60));
  const text = r._text();
  console.log(`\n[${name}] status=${r.statusCode} fetched=${calls[calls.length - 1]?.u || '-'}`);
  console.log('  headers:', JSON.stringify(r.headers));
  console.log('  body:', text.slice(0, 120).replace(/\n/g, ' '));
  if (expect) expect({ res: r, text, fetched: calls[calls.length - 1]?.u });
}

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

// 1) 镜像模式：任意路径直通目标域，不重写 HTML
process.env.PROXY_DOMAIN = 'https://example.com';
await run('mirror /docs/a?x=1', { path: 'docs/a', url: '/docs/a?x=1&path=docs/a' }, ({ res, text, fetched }) => {
  check(fetched === 'https://example.com/docs/a?x=1', '目标 URL = https://example.com/docs/a?x=1');
  check(!/<base/.test(text) && !/proxy\/tok/.test(text), 'HTML 未被重写（无 base 注入）');
});

// 2) 镜像模式：根路径
await run('mirror /', { path: '', url: '/' }, ({ fetched }) => {
  check(fetched === 'https://example.com/', '目标 URL = https://example.com/');
});

// 3) 镜像模式：Location 换域
await run('mirror redirect', { path: 'old', url: '/old', status: 302, resHeaders: { location: 'https://example.com/new?a=1' } }, ({ res }) => {
  check(res.headers.location === 'https://mirror.test/new?a=1', 'Location 改写到镜像域：' + res.headers.location);
});

// 4) 镜像模式：忽略 token/deny/allow（配置里给了也不拦）
process.env.PROXY_DENY = 'example.com';
await run('mirror ignores deny', { path: 'x' }, ({ res }) => {
  check(res.statusCode === 200, '原 deny 列表被忽略（' + res.statusCode + '）');
});

// 5) 口令模式找回：domain 置空
process.env.PROXY_DOMAIN = '';
process.env.PROXY_TOKENS = 'tok';
await run('token mode ok', { path: 'proxy/tok/api.github.com/zen', url: '/' }, ({ fetched }) => {
  check(fetched === 'https://api.github.com/zen', '目标 URL = https://api.github.com/zen');
});
await run('token mode bad token', { path: 'proxy/nope/api.github.com/zen' }, ({ res }) => {
  check(res.statusCode === 401, '错误 token 401');
});
await run('no domain, not /proxy', { path: 'whatever' }, ({ res }) => {
  check(res.statusCode === 404, '未配 domain 且非 /proxy 路径 → 404 提示');
});

// 6) 镜像模式：Set-Cookie 去掉 Domain
process.env.PROXY_DOMAIN = 'https://example.com';
await run('mirror set-cookie', { path: 'login', resHeaders: { 'set-cookie': 'sid=abc; Domain=example.com; Path=/; Secure' } }, ({ res }) => {
  const c = String(res.headers['set-cookie'] || '');
  check(!/domain=/i.test(c) && /sid=abc/.test(c), 'Set-Cookie 去掉 Domain：' + c);
});

// 7) 镜像模式：POST 正文与 content-type 透传
await run('mirror POST', { path: 'api/save', method: 'POST', headers: { 'content-type': 'application/json' }, url: '/api/save' }, ({ fetched }) => {
  const c = globalThis.__last;
  check(fetched === 'https://example.com/api/save', '目标 URL 正确');
  check(c.init.method === 'POST' && c.init.headers['content-type'] === 'application/json', 'POST 方法与 content-type 透传');
});

console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
process.exit(failed ? 1 : 0);
