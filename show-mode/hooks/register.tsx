import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, ToolResultOf } from 'claude-code'

import type { ShowMode, StoredDiff, StoredThought } from '../types'

// 运行时模式：存 $.state；null 表示"未设置"，读时回落到清单配置值。
const mode = atom({ plugin: 'show-mode', key: 'mode' } as const, null as ShowMode | null)

// hidden 模式下保存文件 diff 和思考过程，off 不新增记录。
const diffs = atom({ plugin: 'show-mode', key: 'diffs' } as const, [] as StoredDiff[])
const thoughts = atom({ plugin: 'show-mode', key: 'thoughts' } as const, [] as StoredThought[])
const processRows = atom(
  { plugin: 'show-mode', key: 'processRows' } as const,
  {} as Record<string, boolean>,
)

// 按主会话/子代理隔离。只有随后确实调用了工具的正文，才标记为过程叙述。
const pending = new Map<string, Map<string, string>>()
const loopKey = (agentId?: string) => agentId ?? 'main'

const DIFF_LIMIT = 50
const THOUGHT_LIMIT = 50
const ROW_LIMIT = 2000

// 时:分:秒，记录的时间戳。
const stamp = (at: number) => {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')

  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const MODES: readonly ShowMode[] = ['off', 'hidden']

const MODE_LABEL: Record<ShowMode, string> = {
  off: '正常显示',
  hidden: '完全隐藏',
}

const parseMode = (text: string): ShowMode | null => {
  const lower = text.trim().toLowerCase()

  return MODES.includes(lower as ShowMode) ? (lower as ShowMode) : null
}

type DiffEntry = Omit<StoredDiff, 'id' | 'at'>
type Hunk = ToolResultOf<'Write'>['structuredPatch'][number]

const diffHeaders = (filePath: string, created: boolean) =>
  `--- ${created ? '/dev/null' : JSON.stringify(filePath)}\n+++ ${JSON.stringify(filePath)}\n`

const formatPatch = (filePath: string, created: boolean, hunks: readonly Hunk[]) =>
  diffHeaders(filePath, created) + hunks.map((hunk) =>
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`,
  ).join('')

// 引擎未返回 hunk、但提供了完整前后内容时，生成完整文件替换 diff。
// 不依赖 Git，因此新文件、未暂存文件和非 Git 目录均可回看。
const contentLines = (content: string) => {
  if (content === '') return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

const fullDiff = (filePath: string, created: boolean, before: string, after: string) => {
  const oldLines = contentLines(before)
  const newLines = contentLines(after)
  const removed = oldLines.map((line) => `-${line}`)
  const added = newLines.map((line) => `+${line}`)
  if (before !== '' && !before.endsWith('\n')) removed.push('\\ No newline at end of file')
  if (after !== '' && !after.endsWith('\n')) added.push('\\ No newline at end of file')
  if (oldLines.length === 0 && newLines.length === 0) return diffHeaders(filePath, created)
  return formatPatch(filePath, created, [{
    oldStart: oldLines.length === 0 ? 0 : 1,
    oldLines: oldLines.length,
    newStart: newLines.length === 0 ? 0 : 1,
    newLines: newLines.length,
    lines: [...removed, ...added],
  }])
}

const collectDiffs = (tool: string, output: unknown): DiffEntry[] => {
  if (!output || typeof output !== 'object') return []

  if (tool === 'Write' || tool === 'Edit') {
    const result = output as ToolResultOf<'Write'> | ToolResultOf<'Edit'>
    // staged 表示等待机器所有者审阅，文件尚未写入。
    if (result.staged || typeof result.filePath !== 'string') return []
    const write = 'content' in result ? result : undefined
    const created = write?.type === 'create'
    const before = created ? '' : result.originalFile
    const after = 'content' in result ? result.content : typeof before === 'string'
      ? result.replaceAll
        ? before.split(result.oldString).join(result.newString)
        : before.replace(result.oldString, () => result.newString)
      : null
    const hunks = result.structuredPatch
    if (!created && (!Array.isArray(hunks) || hunks.length === 0)
      && typeof before === 'string' && before === after) return []
    const diff = Array.isArray(hunks) && hunks.length > 0
      ? formatPatch(result.filePath, created, hunks)
      : typeof before === 'string' && typeof after === 'string'
        ? fullDiff(result.filePath, created, before, after)
        : '文件已修改，但工具未提供可用的 diff 或完整修改前内容。'
    return [{ filePath: result.filePath, action: created ? 'create' : 'update', tool, diff }]
  }

  if (tool === 'Bash') {
    // 仅使用引擎明确归属于本次命令的文件 diff，避免混入用户已有的工作区修改。
    const result = output as ToolResultOf<'Bash'>
    return (result.bashEditDiff?.files ?? [])
      .filter((file) => !file.deleted && (file.created || file.hunks.length > 0))
      .map((file) => ({
        filePath: file.filePath,
        action: file.created ? 'create' as const : 'update' as const,
        tool,
        diff: formatPatch(file.filePath, Boolean(file.created), file.hunks),
      }))
  }
  return []
}

// 每次文件更新独立记录，最多保留最近 50 条。
const storeDiffs = async ($: EngineInterface, entries: DiffEntry[]) => {
  if (entries.length === 0) return
  try {
    if ((parseMode((await read($, mode)) ?? '') ?? configured) !== 'hidden') return
    const at = Date.now()
    await update($, diffs, (list) => {
      const firstId = list.length > 0 ? list[list.length - 1]!.id + 1 : 1
      const next = [...list, ...entries.map((entry, index) => ({ ...entry, id: firstId + index, at }))]
      return next.slice(-DIFF_LIMIT)
    })
  } catch {
    // 归档失败不能把已经成功的文件更新报告成失败。
    $.ui.log('show-mode：文件 diff 保存失败', { to: 'debug' })
  }
}

const formatEntry = (entry: StoredDiff) =>
  `── code #${entry.id} ── ${stamp(entry.at)} ── ${entry.action === 'create' ? '新增' : '修改'} ── ${entry.tool}\n${entry.filePath}\n${entry.diff}`

const storeThoughts = async (
  $: EngineInterface,
  kind: StoredThought['kind'],
  texts: string[],
) => {
  const entries = texts.filter((text) => text.trim() !== '')
  if (entries.length === 0) return
  try {
    if ((parseMode((await read($, mode)) ?? '') ?? configured) !== 'hidden') return
    const at = Date.now()
    await update($, thoughts, (list) => {
      const firstId = list.length > 0 ? list[list.length - 1]!.id + 1 : 1
      const next = [...list, ...entries.map((text, index) => ({
        id: firstId + index, at, kind, text,
      }))]
      return next.slice(-THOUGHT_LIMIT)
    })
  } catch {
    $.ui.log('show-mode：思考过程保存失败', { to: 'debug' })
  }
}

const formatThought = (entry: StoredThought) =>
  `── think #${entry.id} ── ${stamp(entry.at)} ── ${entry.kind === 'thinking' ? '思考' : '过程叙述'}\n${entry.text}`

// /show-mode status 按需查看，避免在每个分片上弹 toast。
const stats: {
  starts: number
  fires: number
  chunks: number
  completes: number
  appends: number
  tools: number
  renders: number
  kinds: Record<string, number>
} = { starts: 0, fires: 0, chunks: 0, completes: 0, appends: 0, tools: 0, renders: 0, kinds: {} }

const markProcess = async ($: EngineInterface, agentId?: string) => {
  const key = loopKey(agentId)
  const rows = pending.get(key)
  if (!rows?.size) return

  // 先取走这一批，避免并行工具重复归档同一段正文。
  pending.delete(key)
  if ((parseMode((await read($, mode)) ?? '') ?? configured) !== 'hidden') return
  await update($, processRows, (known) => {
    const next = { ...known }
    for (const id of rows.keys()) next[id] = true
    const ids = Object.keys(next)
    for (const id of ids.slice(0, Math.max(0, ids.length - ROW_LIMIT))) delete next[id]
    return next
  })
  await storeThoughts($, 'narration', [...rows.values()])
}

// 出错/被中断的调用在任何模式下照常显示。
const keepRow = (e: { isErrored?: boolean; isInterrupted?: boolean }) =>
  Boolean(e.isErrored || e.isInterrupted)

// 清单配置的默认模式，register 时赋值
let configured: ShowMode = 'hidden'

export const register: Register = (on, options) => {
  configured = parseMode(String(options.mode ?? '')) ?? 'hidden'

  // 会话开始：注册 /show-mode 命令
  on('session.start', async ($, e, next) => {
    pending.clear()
    await $.command.register({
      name: 'show-mode',
      description: '切换过程显示，回看 hidden 模式保存的文件 diff 和思考过程',
      argumentHint: '[off|hidden|status|view [code|think]]',
    })

    return next(e)
  })

  // /show-mode：
  // - view：回看全部记录；view code / view think：分别查看文件 diff / 思考过程
  // - 无参数在 off 和 hidden 之间切换；带参数直接切换
  on('command.run', { command: 'show-mode' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    // 回看不受当前显示模式限制，off 仍可以查看之前保存的记录。
    if (arg === 'view' || arg.startsWith('view ')) {
      const rest = arg.slice(4).trim()
      if (rest !== '' && rest !== 'code' && rest !== 'think') {
        return { text: '用法：/show-mode view [code|think]；不传参数查看全部' }
      }
      const files = rest === 'think' ? [] : (await read($, diffs)) ?? []
      const thinking = rest === 'code' ? [] : (await read($, thoughts)) ?? []
      const records = [
        ...files.map((entry) => ({ at: entry.at, text: formatEntry(entry) })),
        ...thinking.map((entry) => ({ at: entry.at, text: formatThought(entry) })),
      ].sort((a, b) => a.at - b.at)
      if (records.length === 0) {
        const label = rest === 'code' ? '文件更新 diff' : rest === 'think' ? '思考过程' : '文件更新或思考过程'
        return { text: `show-mode：暂无保存的${label}` }
      }
      const counts = [
        rest === 'think' ? '' : `文件更新 ${files.length} 条`,
        rest === 'code' ? '' : `思考过程 ${thinking.length} 条`,
      ].filter(Boolean).join('，')
      return { text: `show-mode 保存的记录（${counts}）：\n\n${records.map((entry) => entry.text).join('\n\n')}` }
    }

    const current = parseMode((await read($, mode)) ?? '') ?? configured
    const wanted = parseMode(arg)
    if (arg !== '' && arg !== 'status' && wanted === null) {
      return { text: '用法：/show-mode [off|hidden|status|view [code|think]]' }
    }
    const picked = arg === 'status'
      ? current
      : wanted ?? MODES[(MODES.indexOf(current) + 1) % MODES.length]!

    if (arg !== 'status') {
      if (picked !== current) pending.clear()
      await update($, mode, () => picked)
      $.ui.toast(`show-mode: ${picked} (${MODE_LABEL[picked]})`)
    }

    const list = (await read($, diffs)) ?? []
    const thinking = (await read($, thoughts)) ?? []
    const rows = (await read($, processRows)) ?? {}
    const kinds = Object.entries(stats.kinds)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')

    return {
      text: `show-mode ${arg === 'status' ? '当前为' : '已切换为'} ${picked} (${MODE_LABEL[picked]})；已识别 ${Object.keys(rows).length} 条过程消息，已存文件 diff ${list.length} 条、思考过程 ${thinking.length} 条（/show-mode view 回看）；仅 hidden 模式新增记录\n诊断：start=${stats.starts} / append=${stats.appends} / tool=${stats.tools} / AssistantMessage=${stats.renders} / complete=${stats.completes}\nturn.step=${stats.fires} / 分片=${stats.chunks} (${kinds || '无'})`,
    }
  })

  // 新回合不继承上一轮的候选正文，避免把上一轮最终回答隐藏掉。
  on('turn.start', async ($, e, next) => {
    pending.delete(loopKey())
    stats.starts += 1
    return next(e)
  })

  // append 提供实际消息 UUID，对应 AssistantMessage 的 requestId。
  // 正文和 tool_use 可能分开存储，因此还会在 tool.call 时归类。
  on('session.append', async ($, e, next) => {
    if (e.door !== 'response' || e.message.type !== 'assistant') return next(e)
    stats.appends += 1
    const key = loopKey(e.agentId)
    const current = parseMode((await read($, mode)) ?? '') ?? configured
    if (current !== 'hidden') {
      pending.delete(key)
      return next(e)
    }
    const text = e.message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n\n')
    if (text.trim() !== '') {
      const rows = pending.get(key) ?? new Map<string, string>()
      rows.set(e.uuid, text)
      pending.set(key, rows)
    }
    if (e.message.content.some((block) => block.type === 'tool_use')) {
      await markProcess($, e.agentId)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    stats.tools += 1
    const current = parseMode((await read($, mode)) ?? '') ?? configured
    await markProcess($, e.agentId)
    const result = await next(e)
    if (current === 'hidden' && result.deny === undefined && !result.isError && !result.isReadOnly) {
      try {
        await storeDiffs($, collectDiffs(e.tool, result.result))
      } catch {
        $.ui.log(`show-mode：无法解析 ${e.tool} 返回的文件 diff`, { to: 'debug' })
      }
    }
    return result
  })

  // 只隐藏已识别的过程消息；最终回答继续使用原生 Markdown 渲染。
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    stats.renders += 1
    const current = parseMode((await read($, mode)) ?? '') ?? configured
    if (current === 'off') return next(e)
    const rows = await read($, processRows)
    if (!rows[e.requestId]) return next(e)

    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // 真正的 thinking 没有独立渲染站点，只缩减其实时显示。
  // text/tool/input/engine/stop 全部按原顺序透传；签名思考仍由引擎保存。
  on('turn.step', async function* ($, e, next) {
    stats.fires += 1
    const current = parseMode((await read($, mode)) ?? '') ?? configured
    const blocks = new Map<number, string>()
    try {
      for await (const c of next(e)) {
        stats.chunks += 1
        stats.kinds[c.kind] = (stats.kinds[c.kind] ?? 0) + 1
        if (c.kind === 'thinking' && current === 'hidden') {
          blocks.set(c.index, (blocks.get(c.index) ?? '') + c.text)
        } else {
          yield c
        }
      }
    } finally {
      // 流中断时也保留已收到的思考；保存前再次检查模式。
      if (current === 'hidden') await storeThoughts($, 'thinking', [...blocks.values()])
    }
  })

  // 最后没有跟随工具调用的正文保留为回答；中断时也保留现有正文。
  on('turn.complete', async ($, e, next) => {
    stats.completes += 1
    pending.delete(loopKey(e.agentId))
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    pending.clear()
    return next(e)
  })

  // ToolGroup：批量汇总行（Thought for 13s, searched for 2 patterns...）
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const current = parseMode((await read($, mode)) ?? '') ?? configured

    if (current === 'off' || e.props.calls.some(keepRow)) {
      return next(e)
    }

    // hidden：整行不画
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // ToolUse：单个调用行（含 Skill 调用）
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const current = parseMode((await read($, mode)) ?? '') ?? configured

    if (current === 'off') {
      return next(e)
    }

    // 出错/被中断的调用豁免：照常显示
    if (keepRow(e.props)) {
      return next(e)
    }

    // hidden：不画
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // ToolResult：结果块
  // 错误结果保留，成功结果在 hidden 下隐藏。
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const current = parseMode((await read($, mode)) ?? '') ?? configured

    if (current === 'off' || e.props.isErrored) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // Spinner：回合进行中的状态行（Swirling… (46s · ↓ 1.1k tokens)）
  // 任何模式下都不隐藏——这是唯一能看到"还在干活"的地方
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    return next(e)
  })
}
