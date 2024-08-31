export default {
  async fetch(request, env, context) {
    if (request.method === 'GET') {
      const { searchParams } = new URL(request.url)
      const signature = searchParams.get('signature')
      const timestamp = searchParams.get('timestamp')
      const nonce = searchParams.get('nonce')
      const echostr = searchParams.get('echostr')
      const wechat_token_url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${env.WECHAT_APP_ID}&secret=${env.WECHAT_APP_SECRET}`
      const wechat_work_url = 'https://api.weixin.qq.com/cgi-bin/message/template/send?access_token='

      if (signature == 'mess' && echostr != null) { // 发送消息
        const wxtoken = await fetch(wechat_token_url)
        const key = await wxtoken.json()
        var template = {
          "touser": env.WECHAT_USER_ID,
          "template_id": env.WECHAT_TEMP_ID,
          "data": {
            "content": {
              "value": echostr
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

        const response = await fetch(wechat_work_url + key.access_token, push)
        const result = await response.json()
        console.log(JSON.stringify(result))
        return new Response(result, push)
      }
      // 1. 验证签名
      if (!verifySignature(env.WECHAT_TOKEN, signature, timestamp, nonce)) {
        return new Response('Invalid Signature', { status: 401 })
      }

      // 2. 如果是验证服务器配置的请求，直接返回 echostr
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
  console.log(fromUser)
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
