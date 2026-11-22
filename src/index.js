export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)

    // 1. 通知入口：POST /push，头部带 X-Push-Key
    if (url.pathname === '/push' && request.method === 'POST') {
      if (!(await authPush(request, env))) {
        return json({ errcode: 401, errmsg: 'unauthorized' }, 401)
      }
      let content
      try {
        content = (await request.json()).content
      } catch (e) {
        return json({ errcode: 400, errmsg: 'invalid json' }, 400)
      }
      if (!content) {
        return json({ errcode: 400, errmsg: 'missing content' }, 400)
      }
      const result = await sendTemplateMessage(env, String(content))
      return json(result, result.errcode ? 502 : 200)
    }

    if (request.method === 'GET') {
      const { searchParams } = url
      const signature = searchParams.get('signature')
      const timestamp = searchParams.get('timestamp')
      const nonce = searchParams.get('nonce')
      const echostr = searchParams.get('echostr')

      // 2. 验证签名
      if (!(await verifySignature(env.WECHAT_TOKEN, signature, timestamp, nonce))) {
        return new Response('Invalid Signature', { status: 401 })
      }

      // 3. 如果是验证服务器配置的请求，直接返回 echostr
      if (echostr) {
        return new Response(echostr)
      } else {
        return new Response('')
      }
    }

    if (request.method === 'POST') {
      // 3. 解析收到的 XML 消息
      const body = await request.text()
      const message = parseXml(body)
      if ((message.MsgType != 'text') || (message.From != env.WECHAT_USER_ID)) {
        return new Response('') // 回复空消息
      }

      // 4. 根据收到的消息生成回复
      const reply = generateReply(message)
      // 5. 返回 XML 格式的回复消息
      return new Response(reply, {
        headers: { 'Content-Type': 'application/xml' }
      })
    }
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function authPush(request, env) {
  const given = request.headers.get('X-Push-Key')
  const expected = env.PUSH_KEY
  if (!given || !expected) return false
  const encode = new TextEncoder()
  try {
    return crypto.subtle.timingSafeEqual(encode.encode(given), encode.encode(expected))
  } catch (e) {
    return false // 长度不同时 timingSafeEqual 会抛，直接当失败
  }
}

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token'
const SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/template/send?access_token='
const MAX_CONTENT_LENGTH = 200 // 模板内容长度上限，超出会 47003
const TOKEN_SAFETY_MS = 5 * 60 * 1000 // 提前 5 分钟过期，避免卡在边界上
const TOKEN_INVALID_CODES = [40001, 40014, 42001]

// 同一 isolate 内复用 token；跨 isolate 靠 stable_token 普通模式不会互踢
let tokenCache = { value: '', expiresAt: 0 }

function truncate(text, max = MAX_CONTENT_LENGTH) {
  const chars = Array.from(text) // 按码点切，不切坏 emoji
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text
}

async function fetchToken(env, forceRefresh) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'client_credential',
      appid: env.WECHAT_APP_ID,
      secret: env.WECHAT_APP_SECRET,
      force_refresh: !!forceRefresh,
    }),
  })
  const key = await response.json()
  if (!key.access_token) {
    console.error('token error', JSON.stringify(key))
  }
  return key
}

async function getAccessToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) {
    return { access_token: tokenCache.value }
  }
  const key = await fetchToken(env, false)
  if (!key.access_token) {
    return key
  }
  tokenCache = {
    value: key.access_token,
    expiresAt: Date.now() + (key.expires_in || 7200) * 1000 - TOKEN_SAFETY_MS,
  }
  return key
}

async function postTemplate(env, accessToken, content) {
  const template = {
    "touser": env.WECHAT_USER_ID,
    "template_id": env.WECHAT_TEMP_ID,
    "data": {
      "content": {
        "value": content
      }
    }
  }
  const push = {
    body: JSON.stringify(template),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  }

  const response = await fetch(SEND_URL + accessToken, push)
  const result = await response.json()
  console.log('send result', JSON.stringify(result))
  return result
}

async function sendTemplateMessage(env, content) {
  const text = truncate(content)

  const key = await getAccessToken(env)
  if (!key.access_token) {
    return key
  }

  const result = await postTemplate(env, key.access_token, text)
  if (!TOKEN_INVALID_CODES.includes(result.errcode)) {
    return result
  }

  // 缓存的 token 被判失效（被别处刷新等），强刷一次重试
  tokenCache = { value: '', expiresAt: 0 }
  const fresh = await fetchToken(env, true)
  if (!fresh.access_token) {
    return fresh
  }
  return postTemplate(env, fresh.access_token, text)
}

async function verifySignature(token, signature, timestamp, nonce) {
  const tmpStr = [token, timestamp, nonce].sort().join('')
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(tmpStr))
  const computedSignature = Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  return computedSignature === signature
}

const extractTagContent = (tag, xml) => {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`))
  return match ? match[1] : null;
}

function parseXml(xml) {
  const fromUser = extractTagContent("FromUserName", xml)
  //console.log(fromUser)
  const toUser = extractTagContent("ToUserName", xml)
  const content = extractTagContent("Content", xml)
  const type = extractTagContent("MsgType", xml)
  return { From: fromUser, To: toUser, MsgType: type, Content: content }
}

function generateReply(message) {
  const replyContent = `${message.To} said: ${message.Content}`
  return `
<xml>
<ToUserName><![CDATA[${message.From}]]></ToUserName>
<FromUserName><![CDATA[${message.To}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${replyContent}]]></Content>
</xml>`
}

// vim: ts=2 sts=2 sw=2 et
