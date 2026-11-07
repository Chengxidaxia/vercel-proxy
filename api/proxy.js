// Vercel Serverless Function：通用代理（黑名单 + 路径鉴权 + HTML/CSS 重写）
//
// 两种工作模式，由 Edge Config（Global Config）里的 `domain` 一键切换：
//
//   1) 站点镜像模式（domain 非空）
//      proxy 域名整站当成 domain 那个站来用：任意路径 /a/b?x=1 → <domain>/a/b?x=1，
//      响应原样透传（不重写 HTML/CSS，因为同源后相对路径本来就正确），
//      只改写 Location 与 Set-Cookie 的域，让跳转和登录态留在 proxy 域名上。
//      **此模式下 tokens / deny / allow 三项全部忽略。**
//
//   2) 口令代理模式（domain 为空）
//      https://<域名>/proxy/<token>/<目标>?<query>
//      目标可以是「域名/路径」（img.blacknet.cc.cd/pole.jpg），
//      也可以是完整 URL（https://bing.com/search?q=x）——带不带协议头都行。
//      HTML/CSS 重写：对 text/html、text/css 响应把里面的 URL 改写成代理地址，
//      并注入 <base> 兜底相对路径，实现整页浏览（资源也走代理）。
//
// Edge Config 内容（Vercel 面板 → Storage → Global Config → 编辑 JSON）：
//   { "domain": "", "tokens": ["a","b"], "deny": [], "allow": [] }
//
// 环境变量回退（Edge Config 缺失/缺字段时）：
//   PROXY_DOMAIN 站点根链接，如 https://example.com（带不带协议都行）；为空则走口令模式
//   PROXY_TOKENS 逗号分隔 token 列表
//   PROXY_DENY   逗号分隔黑名单
//   PROXY_ALLOW  逗号分隔白名单

import { Readable } from 'node:stream';
import { get as edgeGet } from '@vercel/edge-config';

const DEFAULT_DENY = '';   // 黑名单回退
const DEFAULT_ALLOW = '';  // 白名单回退，默认空 = 走黑名单模式

// 运行时动态配置（Edge Config，面板 JSON 编辑器直接改，秒级生效无需部署）
let _cfg = { t: 0, tokens: null, deny: null, allow: null, domain: null };
async function loadEdgeConfig() {
  const now = Date.now();
  const envDomain = process.env.PROXY_DOMAIN;
  // 没接 Edge Config 时只走环境变量：环境变量读取成本极低，不做缓存，改完立即生效
  if (!process.env.EDGE_CONFIG) {
    _cfg = { t: now, tokens: _cfg.tokens, deny: _cfg.deny, allow: _cfg.allow, domain: envDomain || null };
    return _cfg;
  }
  if (now - _cfg.t < 10000) return _cfg;          // 10s 内存缓存（面板改完最多 10s 生效）
  try {
    const [tokens, deny, allow, domain] = await Promise.all([
      edgeGet('tokens'), edgeGet('deny'), edgeGet('allow'), edgeGet('domain'),
    ]);
    _cfg = {
      t: now,
      tokens: Array.isArray(tokens) ? tokens.map(String).filter(Boolean) : _cfg.tokens,
      deny: Array.isArray(deny) ? deny.map(String) : _cfg.deny,
      allow: Array.isArray(allow) ? allow.map(String) : _cfg.allow,
      domain: typeof domain === 'string' ? domain : (domain == null ? _cfg.domain : String(domain)),
    };
  } catch { _cfg.t = now; }                        // 读失败沿用缓存值
  return _cfg;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';

// 站点根链接归一化：补协议、去尾部斜杠、保留子路径（https://a.com/base）
function normBase(v) {
  if (!v) return '';
  let s = String(v).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return '';
    const base = u.origin + u.pathname.replace(/\/+$/, '');
    return base.replace(/^https?:\/\/[^/]+$/, u.origin);   // 根路径就只留 origin
  } catch { return ''; }
}

// 客户端 query（剔除 rewrite 注入的内部参数 path）
function clientQuery(req) {
  const u0 = new URL(req.url, 'http://x');
  const q0 = new URLSearchParams(u0.search);
  q0.delete('path');
  return q0.toString();
}

const HOP_REQ = /^(host|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|accept-encoding|content-length)$/i;
const HOP_RES = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-encoding|content-length|set-cookie|location)$/i;

// 站点镜像：整站透传。请求 /x/y → <domain>/x/y，响应不重写，
// 只把 Location / Set-Cookie 的域换成 proxy 域，保证跳转与登录态不外逃。
async function serveMirror(req, res, subPath, base) {
  const qs = clientQuery(req);
  const sub = subPath ? '/' + subPath.replace(/^\/+/, '') : '/';
  const target = base + sub + (qs ? '?' + qs : '');

  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (HOP_REQ.test(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (!headers['user-agent']) headers['user-agent'] = UA;

  let r;
  try {
    r = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      redirect: 'manual',                       // 自己改 Location，让跳转留在镜像域里
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    return res.end('proxy error: ' + e.message);
  }

  res.statusCode = r.status;
  for (const [k, v] of r.headers) {
    if (HOP_RES.test(k)) continue;
    res.setHeader(k, v);
  }
  res.removeHeader('content-length');

  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host || '';
  const baseHost = (() => { try { return new URL(base).host; } catch { return ''; } })();
  const sameHost = (h) => {
    const x = String(h || '').toLowerCase().replace(/:\d+$/, '');
    return !!baseHost && x === baseHost.toLowerCase().replace(/:\d+$/, '');
  };

  // 3xx：目标站把绝对地址跳到自己的域 → 换成镜像域，否则用户会被弹回原站
  const loc = r.headers.get('location');
  if (loc && proxyHost) {
    try {
      const abs = new URL(loc, target);
      if (sameHost(abs.host)) abs.host = proxyHost;
      abs.protocol = 'https:';                 // 镜像域只走 https
      res.setHeader('location', abs.href);
    } catch { /* 保持原样 */ }
  } else if (loc) {
    res.setHeader('location', loc);
  }

  // Set-Cookie：去掉 Domain= 让它绑定到镜像域；不改 Path（与原站语义一致）
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (cookies.length) {
    res.setHeader('set-cookie', cookies.map((c) => c.replace(/;\s*domain=[^;]*/gi, '')));
  }

  if (req.method === 'HEAD' || r.status === 204 || r.status === 304) return res.end();
  if (r.body) Readable.fromWeb(r.body).pipe(res);
  else res.end(Buffer.from(await r.arrayBuffer()));
}

export default async function handler(req, res) {
  const ec = await loadEdgeConfig();
  const tokens = (ec && ec.tokens) ||
    (process.env.PROXY_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
  const deny = (ec && ec.deny) ||
    (process.env.PROXY_DENY || DEFAULT_DENY).split(',').map(s => s.trim()).filter(Boolean);
  const allow = (ec && ec.allow) ||
    (process.env.PROXY_ALLOW || DEFAULT_ALLOW).split(',').map(s => s.trim()).filter(Boolean);
  const domain = normBase((ec && ec.domain) || process.env.PROXY_DOMAIN);

  // Vercel 把任意路径 rewrite 到本函数：path 参数在 query 里（见 vercel.json）
  const rawPath = req.query.path || '';
  let rest = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath);
  rest = rest.replace(/^\/+/, '');
  // 兜底：直接命中函数自身（rewrite 目标），当成根路径处理，避免自我循环
  if (/^api\/proxy(\/|$)/i.test(rest) && !domain) rest = '';

  // ---------- 模式一：站点镜像（domain 非空 → 忽略 tokens/deny/allow） ----------
  if (domain) {
    return serveMirror(req, res, rest, domain);
  }

  // ---------- 模式二：口令代理 ----------
  if (!/^proxy(\/|$)/i.test(rest)) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    return res.end('usage: /proxy/<token>/<target>\n' +
      '（若想让本域名整站镜像某个站点，请在 Global Config 里把 "domain" 填成站点根链接）');
  }
  rest = rest.slice('proxy'.length).replace(/^\/+/, '');

  // 结构：<token>/<目标>；保留空段，以识别完整 URL 里的 https://
  const segs = rest.split('/');
  const provided = segs.shift();
  if (!tokens.includes(provided)) return res.status(401).send('invalid token');

  let target = segs.join('/');
  target = target.replace(/^\/+/, '');            // 去前导斜杠
  // 兼容完整 URL：Vercel 边缘会把 // 308 成 /，所以 https:// 和 https:/ 都要认
  target = target.replace(/^https?:\/{1,2}/i, '');
  if (!target) return res.status(400).send('usage: /proxy/<token>/<host>/<path>');

  const host = target.split('/')[0];
  if (allow.length && !allow.includes(host)) return res.status(403).send('host not allowed: ' + host);
  if (deny.includes(host)) return res.status(403).send('host denied: ' + host);

  const PREFIX = '/proxy/' + provided + '/';
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

  const qs = clientQuery(req);
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
    for (const h of ['content-type', 'cache-control', 'etag', 'last-modified', 'content-disposition']) {
      const v = r.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.removeHeader('content-length');
    res.setHeader('access-control-allow-origin', '*');

    const ctype = (r.headers.get('content-type') || '').toLowerCase();
    const isGet = req.method === 'GET';

    // Cloudflare 盾页（质询）透过代理无法通过：IP 信誉校验 + JS 绑定原域名，只会死循环。
    // 与其返回坏页面，不如给一句人话。
    const cfMitigated = r.headers.get('cf-mitigated');
    const cfBlocked = (r.status === 403 || r.status === 503) &&
      /cloudflare/i.test(r.headers.get('server') || '') &&
      (cfMitigated === 'challenge' || /cf-chl|just a moment/i.test(ctype));
    if (cfBlocked && isGet) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><meta charset="utf-8"><title>无法代理</title>' +
        '<body style="font-family:system-ui;max-width:560px;margin:80px auto;line-height:1.7">' +
        '<h2>⛔ 目标站受 Cloudflare 人机验证保护</h2>' +
        '<p>该网站对数据中心 IP（Vercel 服务器）强制弹出质询页，且验证脚本绑定原域名，无法通过透明代理完成。</p>' +
        '<p>请直接访问该网站，或换一个目标。<a href="javascript:history.back()">返回</a></p></body>');
    }

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
          (m, o, css, c) => o + rewriteCss(css) + c)
        // SRI 校验：资源内容经改写后 hash 必不匹配，浏览器会拒载 → 必须移除
        .replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, '');
      const baseHref = PREFIX + pageUrl + (target.includes('/') ? '' : '/');
      // 运行时钩子：SPA（如 Discord）用 JS 动态 fetch/XHR 请求根相对路径（/assets/xxx），
      // <base> 管不了根相对（会打到代理域的根）→ 覆写 fetch/XHR 把它们重写进代理
      const hook = '<script>(function(){var P=' + JSON.stringify(PREFIX) + ',H=' + JSON.stringify(host) +
        ';function fix(u){try{if(typeof u!=="string"||!u)return u;' +
        'if(u.indexOf(P)===0)return u;' +
        'if(/^(data|blob|javascript|mailto|about|tel|ws|wss):/i.test(u))return u;' +
        'if(/^https?:\\/\\//i.test(u))return P+u;' +
        'if(/^\\/\\//.test(u))return P+"https:"+u;' +
        // 域名被当成相对路径（如 JS 拼出 "discord.com/api/x" 或 "/discord.com/api/x"）→ 还原成绝对
        'if(u===H||u.indexOf(H+"/")===0||u.indexOf("/"+H+"/")===0)return P+"https://"+u.replace(/^\\//,"");' +
        'if(/^\\/[^\\/]/.test(u))return P+"https://"+H+u;' +
        'return u}catch(e){return u}}' +
        'var of=window.fetch;' +
        'window.fetch=function(i,o){try{if(typeof i==="string")i=fix(i);else if(i&&i.url)i=new Request(fix(i.url),i)}catch(e){}return of.call(window,i,o)};' +
        'var oo=XMLHttpRequest.prototype.open;' +
        'XMLHttpRequest.prototype.open=function(){try{if(typeof arguments[1]==="string")arguments[1]=fix(arguments[1])}catch(e){}return oo.apply(this,arguments)};' +
        // window.open / location.assign/replace：JS 动态导航也进代理
        'var ow=window.open;' +
        'window.open=function(u){try{if(typeof u==="string")u=fix(u)}catch(e){}return ow.apply(window,arguments)};' +
        'try{var la=location.assign.bind(location),lr=location.replace.bind(location);' +
        'location.assign=function(u){try{u=fix(u)}catch(e){}return la(u)};' +
        'location.replace=function(u){try{u=fix(u)}catch(e){}return lr(u)}}catch(e){}' +
        // 兜底：href="#" 且带 data-track-download 的按钮（JS 里用 location.href= 跳安装包，无法拦截）→ 引导到下载页
        'document.addEventListener("click",function(e){try{var a=e.target&&e.target.closest?e.target.closest("a[href=\\"#\\"][data-track-download]"):null;if(!a)return;e.preventDefault();location.href=fix("https://"+H+"/download")}catch(e){}},true);' +
        // MutationObserver：JS 动态插入的 a/link/img/script/iframe 节点也改写（如移动端导航按钮）
        'function fixEl(el){try{var a=el.tagName==="A"||el.tagName==="LINK"?"href":"src";var v=el.getAttribute&&el.getAttribute(a);if(v){var f=fix(v);if(f!==v)el.setAttribute(a,f)}}catch(e){}}' +
        'var SEL="a[href],link[href],img[src],script[src],iframe[src],source[src],video[src],audio[src]";' +
        'function fixAttr(m){if(m.type==="attributes"){fixEl(m.target)}else{var ns=m.addedNodes||[];for(var j=0;j<ns.length;j++){var n=ns[j];if(n.nodeType!==1)continue;if(n.matches&&n.matches(SEL))fixEl(n);if(n.querySelectorAll)n.querySelectorAll(SEL).forEach(fixEl)}}}' +
        'if(window.MutationObserver){new MutationObserver(function(ms){for(var i=0;i<ms.length;i++)fixAttr(ms[i])}).observe(document.documentElement||document,{childList:true,subtree:true,attributes:true,attributeFilter:["href","src"]})}' +
        '})();<\/script>';
      const head = hook + `<base href="${baseHref}">`;
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, m => m + head)
        : head + html;
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
