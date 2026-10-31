// Vercel Serverless Function：通用代理（白名单版）
// 用法：https://<域名>/proxy/<host>/<path>?<query>
// 例：  https://xxx.vercel.app/proxy/img.blacknet.cc.cd/pole.jpg
//
// 白名单管理：环境变量 PROXY_ALLOW（逗号分隔），未设置时用下方默认值。
// 可选环境变量 PROXY_TOKEN：设置后请求需带 ?token= 或 Authorization: Bearer <token>。

const DEFAULT_ALLOW = 'api.blacknet.cc.cd,img.blacknet.cc.cd,oauth.blacknet.cc.cd,api.github.com,raw.githubusercontent.com';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';

export default async function handler(req, res) {
  const allow = (process.env.PROXY_ALLOW || DEFAULT_ALLOW).split(',').map(s => s.trim()).filter(Boolean);
  const token = process.env.PROXY_TOKEN || '';
  if (token) {
    const q = new URL(req.url, 'http://x').searchParams.get('token');
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (q !== token && auth !== token) return res.status(401).send('token required');
  }

  // Vercel 把 /proxy/xxx/yyy 映射到本函数：path 参数在 query 里（rewrite 方式见 vercel.json）
  const rest = (req.query.path || []).join('/');
  if (!rest) return res.status(400).send('usage: /proxy/<host>/<path>');
  const host = rest.split('/')[0];
  if (!allow.includes(host)) return res.status(403).send('host not allowed: ' + host);

  const target = 'https://' + rest + (new URL(req.url, 'http://x').search || '');
  try {
    const headers = { 'User-Agent': UA };
    const auth = req.headers.authorization;
    if (auth) headers['Authorization'] = auth;
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    const r = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      signal: AbortSignal.timeout(55000),
    });

    res.statusCode = r.status;
    for (const h of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) {
      const v = r.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'HEAD') return res.end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.end('proxy error: ' + e.message);
  }
}
