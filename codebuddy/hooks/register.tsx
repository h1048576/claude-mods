import type { EngineInterface, Register, Timer } from 'claude-code'

const USAGE_URL = 'https://www.codebuddy.cn/billing/meter/get-enterprise-user-usage'
const DAILY_USAGE_URL = 'https://www.codebuddy.cn/billing/meter/get-user-daily-usage'
const AUTH_PATH = '/AppData/Local/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const points = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const today = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: string) => parts.find((value) => value.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

const loadDailyUsage = async ($: EngineInterface, headers: Record<string, string>): Promise<string> => {
  try {
    const date = today()
    const response = await $.http.fetch(DAILY_USAGE_URL, {
      method: 'POST', headers,
      body: JSON.stringify({
        startTime: `${date} 00:00:00`, endTime: `${date} 23:59:59`, pageNum: 1, pageSize: 1,
      }),
    })
    if (!response.ok) return '查询失败'
    const result = object(JSON.parse(response.text))
    if (result.code !== 0) return '查询失败'
    const data = object(result.data)
    if (!Array.isArray(data.data)) return '数据异常'
    if (data.data.length === 0 && points(data.total) === 0) return '0'
    const credit = points(object(data.data[0]).credit)
    return credit === undefined ? '数据异常' : String(Math.trunc(credit))
  } catch {
    return '查询失败'
  }
}

const loadUsage = async ($: EngineInterface): Promise<string> => {
  let account: Record<string, unknown>
  let auth: Record<string, unknown>
  try {
    const home = await $.env.get('USERPROFILE')
    if (!home) return '无法确定用户目录'
    const info = object(JSON.parse((await $.fs.read(
      home.replace(/\\/g, '/').replace(/\/$/, '') + AUTH_PATH,
    )).replace(/^\uFEFF/, '')))
    account = object(info.account)
    auth = object(info.auth)
  } catch {
    return '无法读取登录信息，请先登录 CodeBuddy'
  }

  const enterpriseId = account.enterpriseId
  const accessToken = auth.accessToken
  if (typeof enterpriseId !== 'string' || enterpriseId.trim() === ''
    || typeof accessToken !== 'string' || accessToken.trim() === '') {
    return '登录信息缺少 enterpriseId 或 accessToken'
  }

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'x-enterprise-id': enterpriseId,
      'Content-Type': 'application/json',
    }
    const response = await $.http.fetch(USAGE_URL, {
      method: 'POST',
      headers,
      body: '{}',
    })
    if (response.status === 401 || response.status === 403) return '登录失效或无权限，请重新登录 CodeBuddy'
    if (!response.ok) return `积分查询失败（HTTP ${response.status}）`
    const result = object(JSON.parse(response.text))
    if (result.code !== 0) return '积分接口返回业务错误，请稍后重试'
    const data = object(result.data)
    const credit = points(data.credit)
    const limitNum = points(data.limitNum)
    if (credit === undefined || limitNum === undefined) return '积分接口返回的数据格式异常'
    const dailyUsage = await loadDailyUsage($, headers)
    return `today ${dailyUsage} · remain ${Math.trunc(credit)}/${Math.trunc(limitNum)}`
  } catch {
    // 不输出原始异常、响应或认证信息，避免泄露令牌。
    return '积分查询失败，请检查网络或登录状态'
  }
}

let label = '正在查询积分…'
let timer: Timer | undefined
let pending: Promise<void> | undefined
let generation = 0

const publishUsage = async ($: EngineInterface) => {
  try {
    const home = await $.env.get('USERPROFILE')
    if (!home) return
    await $.fs.write(`${home.replace(/\\/g, '/')}/.claude/codebuddy/usage.json`, JSON.stringify({
      text: `token usage · ${label}`, updatedAt: Date.now(),
    }))
  } catch {
    $.ui.log('无法更新 CodeBuddy 状态栏缓存', { to: 'debug' })
  }
}

const refresh = ($: EngineInterface): Promise<void> => {
  if (pending) return pending
  const current = generation
  pending = (async () => {
    try {
      const nextLabel = await loadUsage($)
      if (current !== generation) return
      label = nextLabel
      await publishUsage($)
    } finally {
      if (current === generation) pending = undefined
    }
  })()
  return pending
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    timer?.cancel()
    generation += 1
    pending = undefined
    label = '正在查询积分…'
    $.ui.status(undefined)
    await $.command.register({ name: 'codebuddy', description: '刷新 CodeBuddy 剩余积分、总积分和今日使用', immediate: true })
    timer = $.clock.every(60_000, () => { void refresh($) })
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'codebuddy' }, async ($) => {
    await refresh($)
    return { text: `token usage · ${label}` }
  })

  on('ui.render', { component: 'InfoNotice' }, ($, e, next) => {
    if (/^(?:●\s*)?codebuddy:\s*reloaded\s*\(\d+ hooks?:[^\r\n]*\)\s*$/.test(e.props.text.trim())) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    timer = undefined
    generation += 1
    pending = undefined
    $.ui.status(undefined)
    return next(e)
  })
}
