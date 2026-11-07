# vercel-proxy — 通用代理（站点镜像 / 口令代理 双模式）

部署在 Vercel（git push 自动上线）。由 Edge Config 里的一个键 `domain` 决定工作模式。

## 模式一：站点镜像（`domain` 非空）

把 `domain` 填成一个站点根链接后，**本代理域名整站当成那个站来用**：

```
https://代理域名/任意/路径?x=1  →  https://domain/任意/路径?x=1
```

- 响应原样透传，**不改写 HTML/CSS**（同源之后相对路径、根相对路径本来就正确）
- 只做两处必要改写：
  - `Location`：目标站跳到自己域时换成代理域，用户不会被弹回原站
  - `Set-Cookie`：去掉 `Domain=`，让登录态绑定在代理域上（`Path` 保持原样）
- **此时 `tokens` / `deny` / `allow` 三项全部忽略**（不需要口令，任意路径直通）
- 顺带好处：原来 `/proxy/<token>/<目标>` 的 Cloudflare 人机验证死循环、SPA 根相对请求等问题都不存在了，因为页面本身就跑在代理域的根上

## 模式二：口令代理（`domain` 为空）

```
https://<域名>/proxy/<token>/<目标>?<query>
目标可以是完整 URL（https://bing.com/search?q=x）或纯域名路径（img.blacknet.cc.cd/pole.jpg）
```

HTML/CSS 重写 + `<base>` 注入 + fetch/XHR/open/assign/replace/MutationObserver 钩子 + SRI 剥离，
支持整页代理浏览。未配 `domain` 时访问 `/proxy/...` 以外的路径返回 404 并提示配置 `domain`。

## 配置（Edge Config / Global Config，实时生效无需部署）

Vercel 面板 → 项目 → **Storage → Global Config (Edge Config)** → 连接到本项目 → 编辑 JSON：

```json
{
  "domain": "",
  "tokens": ["chengxidaxia", "另一个token"],
  "deny": [],
  "allow": []
}
```

保存后秒级生效（函数内 10s 缓存，最多延迟 10 秒）。

| 字段 | 说明 | 空值行为 |
|---|---|---|
| `domain` | 站点根链接，如 `https://example.com`（带不带协议都行，可带子路径）。**非空即切到站点镜像模式，其余三项失效** | 空 = 口令代理模式 |
| `tokens` | 可用口令列表 | 无任何 token（env 也没有）→ 全部 401 |
| `deny` | 黑名单域名 | 不拦截任何域 |
| `allow` | 白名单域名；设了就只放行列表内 | 走黑名单模式 |

## 环境变量回退（Edge Config 缺失/缺字段时）

| 变量 | 说明 |
|---|---|
| `PROXY_DOMAIN` | 站点根链接；非空即镜像模式（未接 Edge Config 时**不做缓存**，改完立即生效） |
| `PROXY_TOKENS` | 逗号分隔的 token 列表 |
| `PROXY_DENY` | 逗号分隔的黑名单 |
| `PROXY_ALLOW` | 逗号分隔的白名单 |

## 路由（vercel.json）

```json
{ "source": "/proxy/:path*", "destination": "/api/proxy?path=proxy/:path*" },
{ "source": "/((?!api(?:/|$)).*)", "destination": "/api/proxy?path=$1" }
```

第一条给口令模式保留原 URL 形态；第二条把其余所有路径交给函数（镜像模式需要）。
`/api/*` 自身不参与 rewrite，避免函数自我循环。

## 本地测试

```
node test-local.mjs            # 9 项断言，mock fetch，不联网
npx -y vercel dev
curl "http://localhost:3000/proxy/<token>/api.github.com/zen"
```

## 已知限制

- 目标站的绝对 URL（写死自己域名的链接）不会被改写，仍指向原站
- 依赖 `Origin`/`Referer` 白名单的接口可能拒绝来自代理域的请求
- 目标站若对数据中心 IP 弹 Cloudflare 质询，镜像模式同样过不去
