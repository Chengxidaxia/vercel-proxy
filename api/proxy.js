// Vercel Serverless Function：通用代理（黑名单版 + 路径鉴权）
// 用法：https://<域名>/proxy/<token>/<host>/<path>?<query>
// 例：  https://xxx.vercel.app/proxy/chengxidaxia/img.blacknet.cc.cd/pole.jpg
//
// 鉴权：令牌写在路径里（第一段），必须与 PROXY_TOKEN 一致，默认 chengxidaxia。
// 访问控制：黑名单模式。PROXY_DENY 为逗号分隔的域名黑名单，默认空 = 不拦截任何域名。
//   （仍可用 PROXY_ALLOW 设为白名单模式：一旦设置，则只放行列表内的域。）
//
// 环境变量（Vercel 面板 → Settings → Environment Variables）：
//   PROXY_TOKEN  路径鉴权口令，默认 chengxidaxia
//   PROXY_DENY   黑名单域名，逗号分隔，默认空
//   PROXY_ALLOW  可选白名单域名，逗号分隔；设置后仅放行这些域（覆盖黑名单）

const DEFAULT_TOKEN = 'chengxidaxia';
const DEFAULT_DENY = '';   // 默认空黑名单
const DEFAULT_ALLOW = '';  // 默认空 = 走黑名单模式

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';

export default async function handler(req, res) {
  const token = process.env.PROXY_TOKEN || DEFAULT_TOKEN;
  const deny = (process.env.PROXY_DENY || DEFAULT_DENY).split(',').map(s => s.trim()).filter(Boolean);
  const allow = (process.env.PROXY_ALLOW || DEFAULT_ALLOW).split(',').map(s => s.trim()).filter(Boolean);

  // Vercel 把 /proxy/xxx/yyy 映射到本函数：path 参数在 query 里（rewrite 见 vercel.json）
  // 注意：单段时 req.query.path 是字符串，多段才是数组
  const rawPath = req.query.path || '';
  const rest = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath);
  // 结构：<token>/<host>/<path...>
  const segs = rest.split('/').filter(Boolean);
  if (segs.length < 2) return res.status(400).send('usage: /proxy/<token>/<host>/<path>');

  const provided = segs.shift();
  if (provided !== token) return res.status(401).send('invalid token');

  const host = segs[0];
  if (allow.length && !allow.includes(host)) return res.status(403).send('host not allowed: ' + host);
  if (deny.includes(host)) return res.status(403).send('host denied: ' + host);

  const target = 'https://' + segs.join('/') + (new URL(req.url, 'http://x').search || '');
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
