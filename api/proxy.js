// Vercel Serverless Function：通用代理（黑名单 + 路径鉴权 + HTML/CSS 重写）
// 用法：https://<域名>/proxy/<token>/<目标>?<query>
// 目标可以是「域名/路径」（img.blacknet.cc.cd/pole.jpg），
// 也可以是完整 URL（https://bing.com/search?q=x）——带不带协议头都行。
//
// HTML/CSS 重写：对 text/html、text/css 响应把里面的 URL 改写成代理地址，
// 并注入 <base> 兜底相对路径，实现整页浏览（资源也走代理）。
// 局限：JS 动态构造的 URL、Cookie 登录态不处理。
//
// 鉴权：令牌写在路径里（第一段），必须与 PROXY_TOKEN 一致，默认 chengxidaxia。
// 访问控制：黑名单模式。PROXY_DENY 为逗号分隔的域名黑名单，默认空 = 不拦截任何域名。
//   （仍可用 PROXY_ALLOW 设为白名单模式：一旦设置，则只放行列表内的域。）
//
// 环境变量（Vercel 面板 → Settings → Environment Variables）：
//   PROXY_TOKEN  路径鉴权口令，默认 chengxidaxia
//   PROXY_DENY   黑名单域名，逗号分隔，默认空
//   PROXY_ALLOW  可选白名单域名，逗号分隔；设置后仅放行这些域（覆盖黑名单）

import { Readable } from 'node:stream';

const DEFAULT_TOKEN = 'chengxidaxia';
const DEFAULT_DENY = '';   // 默认空黑名单
const DEFAULT_ALLOW = '';  // 默认空 = 走黑名单模式

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';

export default async function handler(req, res) {
  const token = process.env.PROXY_TOKEN || DEFAULT_TOKEN;
  const deny = (process.env.PROXY_DENY || DEFAULT_DENY).split(',').map(s => s.trim()).filter(Boolean);
  const allow = (process.env.PROXY_ALLOW || DEFAULT_ALLOW).split(',').map(s => s.trim()).filter(Boolean);

  // Vercel 把 /proxy/xxx 映射到本函数：path 参数在 query 里（rewrite 见 vercel.json）
  const rawPath = req.query.path || '';
  const rest = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath);

  // 结构：<token>/<目标>；保留空段，以识别完整 URL 里的 https://
  const segs = rest.split('/');
  const provided = segs.shift();
  if (provided !== token) return res.status(401).send('invalid token');

  let target = segs.join('/');
  target = target.replace(/^\/+/, '');            // 去前导斜杠
  // 兼容完整 URL：Vercel 边缘会把 // 308 成 /，所以 https:// 和 https:/ 都要认
  target = target.replace(/^https?:\/{1,2}/i, '');
  if (!target) return res.status(400).send('usage: /proxy/<token>/<host>/<path>');

  const host = target.split('/')[0];
  if (allow.length && !allow.includes(host)) return res.status(403).send('host not allowed: ' + host);
  if (deny.includes(host)) return res.status(403).send('host denied: ' + host);

  const PREFIX = '/proxy/' + token + '/';
  const pageUrl = 'https://' + target;            // 当前页面真实 URL（用于解析相对路径）

  // 把任意 URL 包成代理路径；http(s) 以外（data:/javascript:/# 等）原样返回
  // 保留自然 https:// 双斜杠形式（Vercel 会 308 成单斜杠，浏览器自动跟随，函数两种都认）
  const wrap = (u) => {
    try {
      const t = String(u).trim();
      if (!t || /^[#]/.test(t) || /^(javascript|data|mailto|tel|blob|about|ws|wss):/i.test(t)) return u;
      if (t.startsWith(PREFIX)) return u;         // 已是代理地址
      const abs = new URL(t, pageUrl).href;
      if (!/^https?:/i.test(abs)) return u;
      return PREFIX + abs;
    } catch { return u; }
  };

  const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const rewriteCss = (css) => css
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => `@import ${q}${wrap(u)}${q}`)
    .replace(CSS_URL, (m, q, u) => `url(${q}${wrap(u)}${q})`);
  const rewriteSrcset = (v) => v.split(',').map(p => {
    const parts = p.trim().split(/\s+/);
    if (parts[0]) parts[0] = wrap(parts[0]);
    return parts.join(' ');
  }).join(', ');

  // 客户端 query：剔除 rewrite 注入的内部参数 path，其余原样转发给目标
  const u0 = new URL(req.url, 'http://x');
  const q0 = new URLSearchParams(u0.search);
  q0.delete('path');
  const qs = q0.toString();
  const final = 'https://' + target + (qs ? '?' + qs : '');
  try {
    const headers = { 'User-Agent': UA };
    const auth = req.headers.authorization;
    if (auth) headers['Authorization'] = auth;
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    const r = await fetch(final, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      redirect: 'manual',                          // 自己改写 Location，让跳转留在代理里
      signal: AbortSignal.timeout(55000),
    });

    res.statusCode = r.status;
    // fetch 自动解压 gzip/br，content-length 是压缩前长度，与解压后内容不匹配 → 必须丢弃
    for (const h of ['content-type', 'cache-control', 'etag', 'last-modified']) {
      const v = r.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.removeHeader('content-length');
    res.setHeader('access-control-allow-origin', '*');

    const ctype = (r.headers.get('content-type') || '').toLowerCase();
    const isGet = req.method === 'GET';

    // 3xx：把 Location 改写成代理地址（相对 Location 先解析成绝对）
    const loc = r.headers.get('location');
    if (loc) {
      try {
        const abs = new URL(loc, pageUrl).href;
        if (/^https?:/i.test(abs)) res.setHeader('location', PREFIX + abs);
      } catch { /* 保持原样 */ }
    }

    if (req.method === 'HEAD') return res.end();

    // HTML：改写 URL + 注入 <base> 兜底
    if (isGet && ctype.includes('text/html')) {
      let html = await r.text();
      html = html
        .replace(/(\s(?:src|href|action|poster|formaction|data-src)\s*=\s*)(["'])([^"']+)\2/gi,
          (m, a, q, u) => a + q + wrap(u) + q)
        .replace(/(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi,
          (m, a, q, v) => a + q + rewriteSrcset(v) + q)
        .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
          (m, o, css, c) => o + rewriteCss(css) + c);
      const baseHref = PREFIX + pageUrl + (target.includes('/') ? '' : '/');
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, m => m + `<base href="${baseHref}">`)
        : `<base href="${baseHref}">` + html;
      return res.end(html);
    }

    // CSS：改写 url() / @import
    if (isGet && ctype.includes('text/css')) {
      const css = rewriteCss(await r.text());
      return res.end(css);
    }

    // 其余（图片/API/字体等）：流式转发
    if (r.body) {
      Readable.fromWeb(r.body).pipe(res);
    } else {
      res.end(Buffer.from(await r.arrayBuffer()));
    }
  } catch (e) {
    res.statusCode = 502;
    res.end('proxy error: ' + e.message);
  }
}
