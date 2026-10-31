# vercel-proxy — 通用代理（白名单）

部署在 Vercel（git push 自动上线，无额度焦虑）。

## 用法

```
https://<你的vercel域名>/proxy/<host>/<path>?<query>
例：https://xxx.vercel.app/proxy/img.blacknet.cc.cd/pole.jpg
```

## 白名单与口令（Vercel 面板 → Settings → Environment Variables）

| 变量 | 说明 | 默认 |
|---|---|---|
| `PROXY_ALLOW` | 逗号分隔的域名白名单 | 本站四个 worker 域 + GitHub API/raw |
| `PROXY_TOKEN` | 设置后请求需带 `?token=` 或 `Authorization: Bearer` | 不设则免鉴权 |

## 本地测试

```
npx -y vercel dev
curl "http://localhost:3000/proxy/api.github.com/zen"
```
