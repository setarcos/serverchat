# wechat-world

一个跑在 Cloudflare Workers 上的微信通知服务。对外暴露一个带鉴权的 HTTP 接口，收到请求后调用微信公众号的模板消息接口，把内容推送到你的微信。

## 功能

| 路径 | 用途 |
| --- | --- |
| `POST /push` | 推送通知，需要 `X-Push-Key` 头 |
| `GET /` | 微信公众号「服务器配置」的签名校验，由微信调用 |
| `POST /` | 接收用户发来的文本消息并被动回复，由微信调用 |

## 快速开始

### 1. 准备凭据

需要 4 个值，从公众号后台或[测试号](https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login)页面获取：

- `appID`、`appsecret`
- 模板消息的模板 ID，模板正文必须包含 `{{content.DATA}}`
- 你的 openid（测试号页面「用户列表」里那串，关注后才有）

测试号不需要认证、不需要备案，个人自用足够。

### 2. 安装并登录 Cloudflare

```bash
npm install
npx wrangler login
```

### 3. 写入 secret

secret 只在 Cloudflare 侧维护，CI 不碰它们。用 `printf` 而不是 `echo`，避免值末尾多一个换行：

```bash
printf '%s' 'wx1234567890abcdef' | npx wrangler secret put WECHAT_APP_ID
printf '%s' 'appsecret'          | npx wrangler secret put WECHAT_APP_SECRET
printf '%s' 'template_id'        | npx wrangler secret put WECHAT_TEMP_ID
printf '%s' 'openid'             | npx wrangler secret put WECHAT_USER_ID
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put PUSH_KEY
```

`WECHAT_TOKEN` 只有你要用「服务器配置」或被动回复时才需要，填一个自己定的字符串，和微信后台填的一致：

```bash
printf '%s' 'your-random-token' | npx wrangler secret put WECHAT_TOKEN
```

### 4. 部署

```bash
npm run deploy
```

### 5. 调用

```bash
curl -X POST "https://<你的域名>/push" \
  -H "X-Push-Key: $PUSH_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"服务器重启完成"}'
```

成功返回 `{"errcode":0,"errmsg":"ok","msgid":...}`。

## 配置项

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WECHAT_APP_ID` | 是 | 公众号 / 测试号的 appID |
| `WECHAT_APP_SECRET` | 是 | 对应的 appsecret |
| `WECHAT_TEMP_ID` | 是 | 模板消息模板 ID |
| `WECHAT_USER_ID` | 是 | 接收消息的 openid，同时用于过滤被动回复的来源 |
| `PUSH_KEY` | 是 | `/push` 的调用密钥 |
| `WECHAT_TOKEN` | 否 | 公众号后台「服务器配置」里的 Token |

## API

### POST /push

请求体：

```json
{ "content": "要推送的文本" }
```

头：`X-Push-Key: <PUSH_KEY>`

| 状态码 | 响应 | 含义 |
| --- | --- | --- |
| 200 | `{"errcode":0,"errmsg":"ok","msgid":...}` | 微信已受理 |
| 400 | `{"errcode":400,"errmsg":"missing content"}` | 没有 `content` 字段 |
| 400 | `{"errcode":400,"errmsg":"invalid json"}` | 请求体不是合法 JSON |
| 401 | `{"errcode":401,"errmsg":"unauthorized"}` | 缺 key 或 key 不匹配 |
| 502 | 微信原始响应，例如 `{"errcode":43004,"errmsg":"require subscribe"}` | 取 token 或发送失败 |

`content` 超过 200 个字符会按码点截断并补 `…`。按码点切分，emoji 不会被切成半个。

### GET /

微信「服务器配置」的校验入口。按 SHA-1 校验 `signature`，通过则原样返回 `echostr`，否则返回 `401 Invalid Signature`。

### POST /

接收用户消息。只有 `MsgType` 为 `text` 且发送者是 `WECHAT_USER_ID` 时回复，回复内容是 `<公众号原始ID> said: <你的消息>`，其他情况返回空响应。

## 模板要求

模板正文里写 `{{content.DATA}}`，代码固定按下面的结构发送：

```json
{
  "touser": "<WECHAT_USER_ID>",
  "template_id": "<WECHAT_TEMP_ID>",
  "data": { "content": { "value": "..." } }
}
```

两个注意点：

- 字段名必须是 `content`。模板里写 `{{keyword1.DATA}}` 之类会返回 `47003 argument invalid`。
- 2023 年起微信把模板消息单行内容折到 20 字，超出的部分微信自己省略。要发长内容，得在模板里拆成多行 `{{keywordN.DATA}}`。

## 常见错误码

| errcode | 含义 | 处理 |
| --- | --- | --- |
| 40013 | invalid appid | appid 填错，或用了别的账号的 appid |
| 40125 / 40001 | invalid appsecret | 重新生成 AppSecret 并更新 secret |
| 40164 | invalid ip, not in whitelist | 公众号开了 IP 白名单。Workers 出口 IP 不固定，需要删掉白名单或改走固定 IP 中转 |
| 43004 | require subscribe | openid 已取关，或不属于这个公众号 |
| 47003 | argument invalid | 模板字段名不是 `content`，或内容超出限制 |
| 50002 | user limited | 账号被冻结、注销或迁移。登录公众号后台确认状态，一般只能换号 |
| 48001 | api unauthorized | 该账号没有模板消息权限，个人订阅号常见 |

## 实现细节

**token 缓存。** 用 `cgi-bin/stable_token` 的普通模式（`force_refresh: false`），有效期内重复调用返回同一个 token，不会把并发请求的 token 互相踢掉。Worker 每个 isolate 内再缓存一层，过期时间取 `expires_in` 减 5 分钟。发送时若收到 `40001`、`40014`、`42001`，清空缓存并强刷一次，重试一次。

**鉴权。** `X-Push-Key` 与 `PUSH_KEY` 用 `crypto.subtle.timingSafeEqual` 比对，长度不同直接判失败。

## 本地开发

编辑 `.dev.vars`（已在 `.gitignore` 里，当前是空文件），填上同样的 6 个值，然后：

```bash
npm run dev
curl -X POST "http://localhost:8787/push" -H "X-Push-Key: $PUSH_KEY" \
  -H 'Content-Type: application/json' -d '{"content":"local test"}'
```

本地调微信时出口是你本机 IP。如果公众号开了 IP 白名单，本地会拿到 `40164`，和线上表现不一致。

## 测试

```bash
npx vitest run     # 单次
npm test           # watch 模式
```

13 个用例覆盖鉴权、token 缓存命中与过期、token 失效重试、内容截断、状态码。测试通过 mock `fetch` 拦截出站请求，不会打到真实微信接口。

## 部署

```bash
npm run deploy
```

push 到 `master` 会触发 GitHub Actions 部署代码。workflow 里没有任何 `secrets:` 配置，所以部署不会读写 Worker 的 secret，换号时只需要 `wrangler secret put`。

日志：`npx wrangler tail wechat-world` 看实时输出，或在 Dashboard 打开 Workers Logs 查询历史。

## 安全

`PUSH_KEY` 等价于推送权限，泄漏后别人可以往你微信发消息。存到密码管理器（例如 `pass`），不要写进仓库和 shell 历史。轮换时重新 `wrangler secret put PUSH_KEY`，立即生效，不需要重新部署。
