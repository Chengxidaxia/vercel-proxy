// Cloudflare Worker 版通用代理 —— 与 Vercel 版 (api/proxy.js) 功能逐项对齐：
//   /proxy/<token>/<目标>?<query>
//   目标可带 https:// 也可不带；黑名单 PROXY_DENY 默认空；
//   HTML/CSS 重写 + <base> 注入 + Location 跟随 + fetch/XHR/open/assign/replace/MutationObserver 钩子 + SRI 剥离。
// CF Worker 优势：无冷启动、无 55s 超时上限（计费时长内即可）、路径不会被边缘折叠 //。
//
// 配置（CF 面板 → Workers → 该 Worker → Settings → Variables，或 wrangler.toml [vars]）：
//   TOKENS      必填，逗号分隔的可用 token 列表；未配置时所有请求 401
//   PROXY_DENY  可选，逗号分隔黑名单域名，默认空
//   PROXY_ALLOW 可选，逗号分隔白名单域名；设置后仅放行列表内域
// 换 token 改变量保存即生效（isolates 级毫秒级生效，无需部署）。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';

const CF_BLOCKED_PAGE = '<!doctype html><meta charset="utf-8"><title>无法代理</title>' +
  '<body style="font-family:system-ui;max-width:560px;margin:80px auto;line-height:1.7">' +
  '<h2>⛔ 目标站受 Cloudflare 人机验证保护</h2>' +
  '<p>该网站对数据中心 IP 强制弹出质询页，且验证脚本绑定原域名，无法通过透明代理完成。</p>' +
  '<p>请直接访问该网站，或换一个目标。<a href="javascript:history.back()">返回</a></p></body>';

const list = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } });
    }

    if (!path.startsWith('/proxy/')) {
      return new Response('usage: /proxy/<token>/<target>', { status: 400 });
    }

    // CF 不折叠路径里的 //，这里能拿到原始形态：<token>/<目标>
    const tokens = list(env.TOKENS);
    const rest = path.slice('/proxy/'.length);
    const slash = rest.indexOf('/');
    const provided = slash < 0 ? rest : rest.slice(0, slash);
    if (!tokens.includes(provided)) return new Response('invalid token', { status: 401 });

    let target = slash < 0 ? '' : rest.slice(slash + 1);
    target = target.replace(/^\/+/, '');
    target = target.replace(/^https?:\/{1,2}/i, '');   // 兼容完整 URL（带不带协议头、单双斜杠都认）
    if (!target) return new Response('usage: /proxy/<token>/<host>/<path>', { status: 400 });

    const host = target.split('/')[0];
    const allow = list(env.PROXY_ALLOW);
    const deny = list(env.PROXY_DENY);
    if (allow.length && !allow.includes(host)) return new Response('host not allowed: ' + host, { status: 403 });
    if (deny.includes(host)) return new Response('host denied: ' + host, { status: 403 });

    const PREFIX = '/proxy/' + provided + '/';
    const pageUrl = 'https://' + target;

    // 把任意 URL 包成代理路径（保留自然 https:// 形式）
    const wrap = (u) => {
      try {
        const t = String(u).trim();
        if (!t || /^[#]/.test(t) || /^(javascript|data|mailto|tel|blob|about|ws|wss):/i.test(t)) return u;
        if (t.startsWith(PREFIX)) return u;
        const abs = new URL(t, pageUrl).href;
        if (!/^https?:/i.test(abs)) return u;
        return PREFIX + abs;
      } catch { return u; }
    };

    const rewriteCss = (css) => css
      .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => `@import ${q}${wrap(u)}${q}`)
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${wrap(u)}${q})`);
    const rewriteSrcset = (v) => v.split(',').map(p => {
      const parts = p.trim().split(/\s+/);
      if (parts[0]) parts[0] = wrap(parts[0]);
      return parts.join(' ');
    }).join(', ');

    const final = 'https://' + target + url.search;
    try {
      const headers = { 'User-Agent': UA };
      const auth = request.headers.get('authorization');
      if (auth) headers['Authorization'] = auth;
      const ct = request.headers.get('content-type');
      if (ct) headers['Content-Type'] = ct;

      const r = await fetch(final, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',                       // Location 自己改写，跳转留在代理内
      });

      const h = new Headers();
      for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'content-disposition']) {
        const v = r.headers.get(name); if (v) h.set(name, v);
      }
      h.set('access-control-allow-origin', '*');
      // fetch 已解压 gzip/br，透传 content-length 必错 → 丢弃（CF 自动 chunked）

      const ctype = (r.headers.get('content-type') || '').toLowerCase();
      const isGet = request.method === 'GET';

      // CF 盾页透过代理无法通过，给人话提示页
      const cfBlocked = (r.status === 403 || r.status === 503) &&
        /cloudflare/i.test(r.headers.get('server') || '') &&
        (r.headers.get('cf-mitigated') === 'challenge' || /cf-chl|just a moment/i.test(ctype));
      if (cfBlocked && isGet) {
        h.set('content-type', 'text/html; charset=utf-8');
        return new Response(CF_BLOCKED_PAGE, { status: 502, headers: h });
      }

      // 3xx：改写 Location 让跳转留在代理里
      const loc = r.headers.get('location');
      if (loc) {
        try {
          const abs = new URL(loc, pageUrl).href;
          if (/^https?:/i.test(abs)) h.set('location', PREFIX + abs);
        } catch { /* 保持原样 */ }
      }

      if (request.method === 'HEAD') return new Response(null, { status: r.status, headers: h });

      // HTML：改写 URL + 注入 <base> + 运行时钩子 + 剥 SRI
      if (isGet && ctype.includes('text/html')) {
        let html = await r.text();
        html = html
          .replace(/(\s(?:src|href|action|poster|formaction|data-src)\s*=\s*)(["'])([^"']+)\2/gi,
            (m, a, q, u) => a + q + wrap(u) + q)
          .replace(/(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi,
            (m, a, q, v) => a + q + rewriteSrcset(v) + q)
          .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
            (m, o, css, c) => o + rewriteCss(css) + c)
          .replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, '');
        const baseHref = PREFIX + pageUrl + (target.includes('/') ? '' : '/');
        const hook = '<script>(function(){var P=' + JSON.stringify(PREFIX) + ',H=' + JSON.stringify(host) +
          ';function fix(u){try{if(typeof u!=="string"||!u)return u;' +
          'if(u.indexOf(P)===0)return u;' +
          'if(/^(data|blob|javascript|mailto|about|tel|ws|wss):/i.test(u))return u;' +
          'if(/^https?:\\/\\//i.test(u))return P+u;' +
          'if(/^\\/\\//.test(u))return P+"https:"+u;' +
          'if(u===H||u.indexOf(H+"/")===0||u.indexOf("/"+H+"/")===0)return P+"https://"+u.replace(/^\\//,"");' +
          'if(/^\\/[^\\/]/.test(u))return P+"https://"+H+u;' +
          'return u}catch(e){return u}}' +
          'var of=window.fetch;' +
          'window.fetch=function(i,o){try{if(typeof i==="string")i=fix(i);else if(i&&i.url)i=new Request(fix(i.url),i)}catch(e){}return of.call(window,i,o)};' +
          'var oo=XMLHttpRequest.prototype.open;' +
          'XMLHttpRequest.prototype.open=function(){try{if(typeof arguments[1]==="string")arguments[1]=fix(arguments[1])}catch(e){}return oo.apply(this,arguments)};' +
          'var ow=window.open;' +
          'window.open=function(u){try{if(typeof u==="string")u=fix(u)}catch(e){}return ow.apply(window,arguments)};' +
          'try{var la=location.assign.bind(location),lr=location.replace.bind(location);' +
          'location.assign=function(u){try{u=fix(u)}catch(e){}return la(u)};' +
          'location.replace=function(u){try{u=fix(u)}catch(e){}return lr(u)}}catch(e){}' +
          'document.addEventListener("click",function(e){try{var a=e.target&&e.target.closest?e.target.closest("a[href=\\"#\\"][data-track-download]"):null;if(!a)return;e.preventDefault();location.href=fix("https://"+H+"/download")}catch(e){}},true);' +
          'function fixEl(el){try{var a=el.tagName==="A"||el.tagName==="LINK"?"href":"src";var v=el.getAttribute&&el.getAttribute(a);if(v){var f=fix(v);if(f!==v)el.setAttribute(a,f)}}catch(e){}}' +
          'var SEL="a[href],link[href],img[src],script[src],iframe[src],source[src],video[src],audio[src]";' +
          'function fixAttr(m){if(m.type==="attributes"){fixEl(m.target)}else{var ns=m.addedNodes||[];for(var j=0;j<ns.length;j++){var n=ns[j];if(n.nodeType!==1)continue;if(n.matches&&n.matches(SEL))fixEl(n);if(n.querySelectorAll)n.querySelectorAll(SEL).forEach(fixEl)}}}' +
          'if(window.MutationObserver){new MutationObserver(function(ms){for(var i=0;i<ms.length;i++)fixAttr(ms[i])}).observe(document.documentElement||document,{childList:true,subtree:true,attributes:true,attributeFilter:["href","src"]})}' +
          '})();<\/script>';
        const head = hook + `<base href="${baseHref}">`;
        html = /<head[^>]*>/i.test(html)
          ? html.replace(/<head[^>]*>/i, m => m + head)
          : head + html;
        return new Response(html, { status: r.status, headers: h });
      }

      // CSS：改写 url() / @import
      if (isGet && ctype.includes('text/css')) {
        return new Response(rewriteCss(await r.text()), { status: r.status, headers: h });
      }

      // 其余：流式透传
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) {
      return new Response('proxy error: ' + (e && e.message), { status: 502 });
    }
  },
};
