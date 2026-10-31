# vercel-proxy — 通用代理（token 列表 + 黑名单 + HTML 重写）

部署在 Vercel（git push 自动上线）。HTML/CSS 重写 + fetch/XHR 钩子，支持整页代理浏览。

## 用法

```
https://<域名>/proxy/<token>/<目标>?<query>
目标可以是完整 URL（https://bing.com/search?q=x）或纯域名路径（img.blacknet.cc.cd/pole.jpg）
```

## token 管理（Edge Config，实时生效无需部署）

token 是**列表**，命中任一即通过；**没有硬编码默认值**——列表为空则全部 401。

配置位置：Vercel 面板 → 项目 → **Storage → Global Config (Edge Config)** → 连接到本项目 → 编辑 JSON：

```json
{
  "tokens": ["chengxidaxia", "另一个token"],
  "deny": [],
  "allow": []
}
```

保存后秒级生效（函数内 10s 缓存，最多延迟 10 秒）。

| 字段 | 说明 | 空值行为 |
|---|---|---|
| `tokens` | 可用口令列表 | 无任何 token（env 也没有）→ 全部 401 |
| `deny` | 黑名单域名 | 不拦截任何域 |
| `allow` | 白名单域名；设了就只放行列表内 | 走黑名单模式 |

## 环境变量回退（Edge Config 缺失/缺字段时）

| 变量 | 说明 |
|---|---|
| `PROXY_TOKENS` | 逗号分隔的 token 列表 |
| `PROXY_DENY` | 逗号分隔的黑名单 |
| `PROXY_ALLOW` | 逗号分隔的白名单 |

## 本地测试

```
npx -y vercel dev
curl "http://localhost:3000/proxy/<token>/api.github.com/zen"
```
