import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ENV = {
  WECHAT_APP_ID: 'wxappid',
  WECHAT_APP_SECRET: 'appsecret',
  WECHAT_TEMP_ID: 'tplid',
  WECHAT_USER_ID: 'openid',
  PUSH_KEY: 'test-key',
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pushRequest(content, key = ENV.PUSH_KEY) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['X-Push-Key'] = key
  return new Request('https://example.com/push', {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
  })
}

let worker
let tokenBodies
let tokenUsed
let sentBodies

function installFetch({ expiresIn = 7200, sendResults = [] } = {}) {
  const plan = [...sendResults]
  let tokenNo = 0
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = String(input)
    if (url.includes('/cgi-bin/stable_token')) {
      tokenBodies.push(JSON.parse(init.body))
      tokenNo += 1
      return jsonResponse({ access_token: `tok${tokenNo}`, expires_in: expiresIn })
    }
    if (url.includes('/message/template/send')) {
      sentBodies.push(JSON.parse(init.body))
      tokenUsed.push(url.split('access_token=')[1])
      return jsonResponse(plan.length ? plan.shift() : { errcode: 0, errmsg: 'ok', msgid: 1 })
    }
    throw new Error('unexpected fetch: ' + url)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(async () => {
  // tokenCache 是模块级状态，每个用例都拿一份新的
  vi.resetModules()
  worker = (await import('../src/index.js')).default
  tokenBodies = []
  tokenUsed = []
  sentBodies = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('鉴权', () => {
  it('缺 X-Push-Key 返回 401，且不碰微信接口', async () => {
    const fetchMock = installFetch()
    const response = await worker.fetch(pushRequest('hi', null), ENV, {})
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ errcode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('key 错误返回 401', async () => {
    const fetchMock = installFetch()
    const response = await worker.fetch(pushRequest('hi', 'wrong-key'), ENV, {})
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('老的 GET ?signature=mess 后门已关闭', async () => {
    const fetchMock = installFetch()
    const response = await worker.fetch(
      new Request('https://example.com/?signature=mess&echostr=hi'),
      ENV,
      {},
    )
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('token 缓存', () => {
  it('连续两次推送只取一次 token', async () => {
    const fetchMock = installFetch()

    await worker.fetch(pushRequest('第一条'), ENV, {})
    await worker.fetch(pushRequest('第二条'), ENV, {})

    expect(tokenBodies).toHaveLength(1)
    expect(sentBodies).toHaveLength(2)
    expect(tokenUsed).toEqual(['tok1', 'tok1'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('取 token 用 stable_token 普通模式，不是强制刷新', async () => {
    installFetch()
    await worker.fetch(pushRequest('hi'), ENV, {})

    expect(tokenBodies[0]).toMatchObject({
      grant_type: 'client_credential',
      appid: ENV.WECHAT_APP_ID,
      secret: ENV.WECHAT_APP_SECRET,
      force_refresh: false,
    })
  })

  it('超过 expires_in 的缓存会失效并重新获取', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_700_000_000_000)
    installFetch({ expiresIn: 7200 })

    await worker.fetch(pushRequest('第一条'), ENV, {})
    expect(tokenBodies).toHaveLength(1)

    // 还在有效期内（7200s 减去 5min 安全余量 → 6900s）
    now.mockReturnValue(1_700_000_000_000 + 6800 * 1000)
    await worker.fetch(pushRequest('第二条'), ENV, {})
    expect(tokenBodies).toHaveLength(1)

    // 越过有效期
    now.mockReturnValue(1_700_000_000_000 + 6900 * 1000)
    await worker.fetch(pushRequest('第三条'), ENV, {})
    expect(tokenBodies).toHaveLength(2)
    expect(tokenUsed).toEqual(['tok1', 'tok1', 'tok2'])
  })

  it('expires_in 小于安全余量时不会缓存住', async () => {
    installFetch({ expiresIn: 60 })
    await worker.fetch(pushRequest('第一条'), ENV, {})
    await worker.fetch(pushRequest('第二条'), ENV, {})
    expect(tokenBodies).toHaveLength(2)
  })

  it('发送返回 42001 时强刷 token 并重试一次', async () => {
    installFetch({
      sendResults: [
        { errcode: 42001, errmsg: 'access_token expired' },
        { errcode: 0, errmsg: 'ok', msgid: 2 },
      ],
    })

    const response = await worker.fetch(pushRequest('重试'), ENV, {})

    expect(tokenBodies).toHaveLength(2)
    expect(tokenBodies[0].force_refresh).toBe(false)
    expect(tokenBodies[1].force_refresh).toBe(true)
    expect(tokenUsed).toEqual(['tok1', 'tok2'])
    expect(await response.json()).toMatchObject({ errcode: 0 })
    expect(response.status).toBe(200)
  })

  it('非 token 类错误不触发重试', async () => {
    installFetch({ sendResults: [{ errcode: 43004, errmsg: 'require subscribe' }] })

    const response = await worker.fetch(pushRequest('hi'), ENV, {})

    expect(tokenBodies).toHaveLength(1)
    expect(sentBodies).toHaveLength(1)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ errcode: 43004 })
  })
})

describe('内容截断', () => {
  it('超过 200 字符截断并补省略号', async () => {
    installFetch()
    const response = await worker.fetch(pushRequest('a'.repeat(201)), ENV, {})

    const value = sentBodies[0].data.content.value
    expect(Array.from(value)).toHaveLength(200)
    expect(value.endsWith('…')).toBe(true)
    expect(await response.json()).toMatchObject({ errcode: 0 })
  })

  it('正好 200 字符不截断', async () => {
    installFetch()
    await worker.fetch(pushRequest('a'.repeat(200)), ENV, {})
    expect(sentBodies[0].data.content.value).toBe('a'.repeat(200))
  })

  it('emoji 不会被切坏', async () => {
    installFetch()
    await worker.fetch(pushRequest('👍'.repeat(250)), ENV, {})

    const value = sentBodies[0].data.content.value
    expect(Array.from(value)).toHaveLength(200)
    expect(value).toBe('👍'.repeat(199) + '…')
  })

  it('缺 content 返回 400', async () => {
    installFetch()
    const request = new Request('https://example.com/push', {
      method: 'POST',
      headers: { 'X-Push-Key': ENV.PUSH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const response = await worker.fetch(request, ENV, {})
    expect(response.status).toBe(400)
  })
})
