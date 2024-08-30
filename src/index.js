
export default {
  async fetch(request, env, context) {
    const { searchParams } = new URL(request.url)
    const signature = searchParams.get('signature')
    const timestamp = searchParams.get('timestamp')
    const nonce = searchParams.get('nonce')
    const echostr = searchParams.get('echostr')

    // 1. 验证签名
    if (!verifySignature(env.WECHAT_TOKEN, signature, timestamp, nonce)) {
        return new Response('Invalid Signature', { status: 401 })
    }

    // 2. 如果是验证服务器配置的请求，直接返回 echostr
    if (echostr) {
        return new Response(echostr)
    }

    // 3. 解析收到的 XML 消息
    const body = await request.text()
    const message = parseXml(body)

    // 4. 根据收到的消息生成回复
    const reply = generateReply(message)
    // 5. 返回 XML 格式的回复消息
    return new Response(reply, {
        headers: { 'Content-Type': 'application/xml' }
    })
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
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`));
  return match ? match[1] : null;
}

function parseXml(xml) {
  const fromUser = extractTagContent("FromUserName", xml);
  console.log(fromUser)
  const toUser = extractTagContent("ToUserName", xml);
  const content = extractTagContent("Content", xml);
  return { From: fromUser, To: toUser, MsgType: 'text', Content: content }
}

function generateReply(message) {
  const replyContent = `You said: ${message.Content}`
  return `
<xml>
<ToUserName><![CDATA[${message.From}]]></ToUserName>
<FromUserName><![CDATA[${message.To}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${replyContent}]]></Content>
</xml>`
}
