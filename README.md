# vercel-proxy — 通用代理（黑名单 + 路径鉴权）

部署在 Vercel（git push 自动上线，无额度焦虑）。

## 用法

```
https://<你的vercel域名>/proxy/<token>/<host>/<path>?<query>
例：https://xxx.vercel.app/proxy/chengxidaxia/img.blacknet.cc.cd/pole.jpg
```

- `<token>`：路径第一段，鉴权口令，默认 `chengxidaxia`
- `<host>`：目标域名（第二段）
- `<path>`：目标路径（其余段）

## 访问控制

- **黑名单模式（默认）**：`PROXY_DENY` 为空时，除显式拉黑的域名外全部放行。
- **白名单模式（可选）**：设置 `PROXY_ALLOW` 后，仅放行列表内的域名（覆盖黑名单）。

## 环境变量（Vercel 面板 → Settings → Environment Variables）

| 变量 | 说明 | 默认 |
|---|---|---|
| `PROXY_TOKEN` | 路径里的鉴权口令 | `chengxidaxia` |
| `PROXY_DENY` | 逗号分隔的黑名单域名 | 空（不拦截） |
| `PROXY_ALLOW` | 逗号分隔的白名单域名；设置后仅放行这些域 | 空（走黑名单） |

## 本地测试

```
npx -y vercel dev
curl "http://localhost:3000/proxy/chengxidaxia/api.github.com/zen"
```
