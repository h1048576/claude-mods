import type { EngineInterface, Register } from 'claude-code'
import { lineLength, OUTPUT_LIMIT, OUTPUT_LINE_LIMIT, parseOutput, renderOutput, serializeOutput } from './output'
import type { OutputLine } from './output'

// 只在当前会话内保持模式和目录，重载后回到正常对话。
let active = false
let running = false
let cwd = ''
let bash = ''
let draft = ''
let history: OutputLine[] = []
let generation = 0
let columns = 80
let skipCloseArchive = false
let pendingArchive = ''

const PANE_ID = 'shell-console'
const INPUT_KEY = 'shell-command'
const OUTPUT_COMMAND = 'shell-mode-output'
const CWD_MARKER = '\0shell-mode-cwd\0'
const ARCHIVE_REFERENCE = /\[shell-mode-output:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\]/i

const archivePath = async ($: EngineInterface, id: string) => {
  const localAppData = await $.env.get('LOCALAPPDATA')
  if (localAppData) return `${localAppData.replace(/\\/g, '/')}/Claude/shell-mode/history/${id}.txt`
  const userProfile = await $.env.get('USERPROFILE')
  if (userProfile) return `${userProfile.replace(/\\/g, '/')}/.claude/shell-mode/history/${id}.txt`
  throw new Error('无法确定 Shell 历史记录的本地保存目录')
}

// command.run 返回的文字会被 Claude 读取，因此只返回引用，实际输出单独存文件。
// 文件名只使用插件生成的 UUID，不使用命令、路径或命令输出作为文件名。
const saveArchive = async ($: EngineInterface, text: string) => {
  if (text === '') return ''
  const id = crypto.randomUUID()
  await $.fs.write(await archivePath($, id), text)
  return `[shell-mode-output:${id}]`
}

const readArchive = async ($: EngineInterface, reference: string) => {
  const id = ARCHIVE_REFERENCE.exec(reference)?.[1]
  if (id === undefined) return undefined
  return $.fs.read(await archivePath($, id))
}

// 控制台用 Text 保留换行，不经过附带插件名前缀的 ui.log。
// 同时限制单次输出和整个控制台的历史，避免连续执行后无限增长。
const trimHistory = () => {
  let length = history.reduce((total, line) => total + lineLength(line), 0) + Math.max(0, history.length - 1)
  let runs = history.reduce((total, line) => total + line.length, 0)
  while (history.length > OUTPUT_LINE_LIMIT || length > OUTPUT_LIMIT || runs > 4_000) {
    const oldest = history.shift()
    if (oldest !== undefined) {
      length -= lineLength(oldest) + (history.length > 0 ? 1 : 0)
      runs -= oldest.length
    }
  }
}

const appendOutput = (text: string) => {
  const output = parseOutput(text)
  history.push(...output.lines)
  trimHistory()
  return output.truncated
}

// 命令通过独立 argv 传入，交给 Bash 解释；不在包装脚本中拼接命令。
// 登录配置先由 Bash 加载，再开启非交互 alias 展开并恢复本次工作目录。
// EXIT 时从 stderr 回传实际目录，支持 cd、带空格路径及复合命令。
const BASH_SCRIPT = String.raw`
builtin shopt -s expand_aliases
builtin cd -- "$2" || exit
builtin trap '__shell_mode_exit=$?; builtin printf "\0shell-mode-cwd\0%s\0" "$(builtin pwd -W)" >&2; exit "$__shell_mode_exit"' EXIT
__shell_mode_columns="$3"
if [[ "$4" == 1 ]]; then
  # 仅对直接显示的命令模拟终端格式；管道、重定向等保持原行为。
  # 保留用户 alias 和已有同名函数，显式 -1、-l、--color=never 等参数优先。
  if ! builtin declare -F ls >/dev/null; then
    function ls {
      local __shell_mode_arg
      for __shell_mode_arg in "$@"; do
        builtin shift
        [[ "$__shell_mode_arg" == --color=auto ]] && __shell_mode_arg=--color=always
        builtin set -- "$@" "$__shell_mode_arg"
      done
      builtin command ls --color=always -C --tabsize=0 --width="$__shell_mode_columns" "$@"
    }
  fi
  if ! builtin declare -F git >/dev/null; then
    function git { builtin command git -c color.ui=always "$@"; }
  fi
fi
builtin eval "$1"
`

const findBash = async ($: EngineInterface) => {
  const override = await $.env.get('CLAUDE_CODE_GIT_BASH_PATH')
  if (override) {
    if (await $.fs.exists(override)) return override
    throw new Error(`CLAUDE_CODE_GIT_BASH_PATH 指向的 Bash 不存在：${override}`)
  }

  const programFiles = await $.env.get('ProgramFiles')
  const programW6432 = await $.env.get('ProgramW6432')
  const localAppData = await $.env.get('LOCALAPPDATA')
  const userProfile = await $.env.get('USERPROFILE')
  const candidates = [
    programW6432 && `${programW6432}/Git/bin/bash.exe`,
    programFiles && `${programFiles}/Git/bin/bash.exe`,
    localAppData && `${localAppData}/Programs/Git/bin/bash.exe`,
    userProfile && `${userProfile}/scoop/apps/git/current/bin/bash.exe`,
    'C:/Program Files/Git/bin/bash.exe',
  ]
  for (const candidate of new Set(candidates)) {
    if (candidate && await $.fs.exists(candidate)) return candidate
  }
  throw new Error('未找到 Git Bash，请安装 Git for Windows，或设置 CLAUDE_CODE_GIT_BASH_PATH')
}

const resetShell = () => {
  active = false
  running = false
  draft = ''
  history = []
  generation += 1
}

const exitShell = async ($: EngineInterface, archive = true) => {
  skipCloseArchive = !archive
  try {
    await $.ui.close({ id: PANE_ID })
    resetShell()
    $.ui.invalidate('ui.render')
  } finally {
    skipCloseArchive = false
  }
}

const executeCommand = async ($: EngineInterface, command: string) => {
  const currentGeneration = generation
  running = true
  draft = ''
  appendOutput(`$ ${command}`)
  $.ui.invalidate('ui.render')
  try {
    await $.ui.scroll({ in: PANE_ID, to: 'end' })
    if (!active || generation !== currentGeneration) return
    // 不能给管道、重定向或复合命令注入颜色与列格式，以免改变其数据。
    const terminalOutput = !/[|&;<>()\r\n`$\\]/.test(command)
    const result = await $.process.run(
      [bash, '--login', '-c', BASH_SCRIPT, 'shell-mode', command, cwd, String(columns), terminalOutput ? '1' : '0'],
      {
        cwd,
        timeoutMs: 600_000,
        env: {
          COLUMNS: String(columns),
          ...(terminalOutput ? { TERM: 'xterm-256color', CLICOLOR: '1', CLICOLOR_FORCE: '1', FORCE_COLOR: '1' } : {}),
        },
      },
    )
    // 退出或重新进入后，不把旧命令的输出和目录带到新控制台。
    if (!active || generation !== currentGeneration) return
    let stderr = result.stderr
    const marker = stderr.lastIndexOf(CWD_MARKER)
    if (marker !== -1 && stderr.endsWith('\0')) {
      const directory = stderr.slice(marker + CWD_MARKER.length, -1)
      if (directory !== '') cwd = directory
      stderr = stderr.slice(0, marker)
    }
    const output = [result.stdout, stderr]
      .filter(Boolean)
      .map(text => text.replace(/(?:\r?\n)+$/, ''))
      .join('\n')
    const truncated = output !== '' && appendOutput(output)
    if (truncated || result.isStdoutTruncated || result.isStderrTruncated) {
      appendOutput('命令输出过长，已截断显示。')
    }
  } catch (error) {
    if (active && generation === currentGeneration) {
      appendOutput(`Shell 执行失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } finally {
    if (active && generation === currentGeneration) {
      running = false
      history.push([])
      trimHistory()
      $.ui.invalidate('ui.render')
      await $.ui.scroll({ in: PANE_ID, to: 'end' })
    }
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    resetShell()
    await exitShell($, false)
    cwd = e.cwd
    bash = ''
    await $.command.register({
      name: 'shell-mode',
      description: '切换 Bash 模式：首次输入进入，再次输入退出；也可输入 exit 退出',
      argumentHint: '[on|off]',
    })
    await $.command.register({
      name: OUTPUT_COMMAND,
      description: '保存 Shell 控制台输出',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'shell-mode' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || (arg === '' && active)) {
      try {
        const text = await saveArchive($, serializeOutput(history))
        // 原生 slash 命令直接返回引用，避免在 command.run 中等待另一个命令。
        await exitShell($, false)
        return text === '' ? {} : { text }
      } catch (error) {
        $.ui.toast(`无法保存 Shell 输出，控制台继续保留：${error instanceof Error ? error.message : String(error)}`)
        return {}
      }
    }
    if (arg !== '' && arg !== 'on') {
      $.ui.toast('用法：/shell-mode 切换 Bash 模式；on 明确开启，off 或 exit 退出。')
      return {}
    }
    try {
      if (!active) {
        bash = await findBash($)
        cwd = await $.session.cwd()
        columns = Math.max(20, e.presentation.columns - 4)
        active = true
      }
      $.ui.invalidate('ui.render')
      const opened = await $.ui.open({
        id: PANE_ID,
        title: 'Shell Mode',
        focus: true,
        closeOnEscape: true,
        rows: 18,
      })
      if (!opened.isPlaced) throw new Error(opened.reason)
      await $.ui.focus({ requestId: PANE_ID, key: INPUT_KEY })
      await $.ui.scroll({ in: PANE_ID, to: 'end' })
    } catch (error) {
      await exitShell($, false)
      $.ui.toast(`无法进入 Shell Mode：${error instanceof Error ? error.message : String(error)}`)
    }
    return {}
  })

  on('command.describe', { command: OUTPUT_COMMAND }, async ($, e, next) => ({
    ...await next(e),
    isHidden: true,
  }))

  on('command.run', { command: OUTPUT_COMMAND }, () => {
    const text = pendingArchive
    pendingArchive = ''
    return text === '' ? {} : { text }
  })

  // CLI 记录只保留引用，从本地文件恢复内容及颜色，重绘/重载不依赖临时历史。
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (![OUTPUT_COMMAND, 'shell-mode'].includes(e.props.command) || e.props.isErrored) return next(e)
    try {
      const text = await readArchive($, e.props.text)
      if (text === undefined) return next(e)
      const lines = parseOutput(text).lines
      lines.push([])
      return renderOutput($.ui.resolve(e), lines)
    } catch {
      return $.ui.resolve(e).Text({ children: 'Shell 历史记录无法读取，请检查本地存档是否仍然存在。', dimColor: true })
    }
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.props.origin.kind === 'plugin' && e.props.origin.name === 'shell-mode'
      && /(?:^|\n)\/shell-mode-output(?:\s|$)/.test(e.props.text)) {
      return $.ui.resolve(e).Box({ children: [] })
    }
    return next(e)
  })

  // 命令从独立 Input 提交，不触发 prompt.submit，也不产生 Prompt dropped 通知。
  on('ui.input', { plugin: 'shell-mode', element: INPUT_KEY, requestId: PANE_ID }, async ($, e) => {
    if (!active) return { element: e.element, value: '' }
    if (e.kind === 'change') {
      draft = e.value
      $.ui.invalidate('ui.render')
      return { element: e.element, value: draft }
    }
    const command = e.value.trim()
    if (command === 'exit' || command === '/shell-mode' || command === '/shell-mode off') {
      await exitShell($)
      return { element: e.element, value: '' }
    }
    if (command === '' || command === '/shell-mode on') {
      draft = ''
      $.ui.invalidate('ui.render')
      return { element: e.element, value: '' }
    }
    if (running) return { element: e.element, value: draft }
    await executeCommand($, command)
    return { element: e.element, value: draft }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return Text({ children: '请在 Claude Code 终端中使用 Shell Mode。' })
    }
    const { Box, Text, Input } = $.ui.resolve(e)
    columns = Math.max(20, e.props.bodyColumns)
    return Box({
      flexDirection: 'column',
      children: [
        renderOutput({ Box, Text }, history),
        Box({
          flexDirection: 'row',
          children: [
            Text({ children: '$ ' }),
            Input({
              key: INPUT_KEY,
              value: draft,
              autoFocus: true,
              submitLabel: '',
              onSubmit: () => {},
            }),
          ],
        }),
      ],
    })
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const text = active && !skipCloseArchive ? serializeOutput(history) : ''
    // 在卸载输入控件前保存，避免退出时的输入事件被卸载取消。
    if (text !== '') {
      try {
        pendingArchive = await saveArchive($, text)
        await $.command.run({ command: OUTPUT_COMMAND })
      } catch (error) {
        $.ui.toast(`无法保存 Shell 输出，控制台继续保留：${error instanceof Error ? error.message : String(error)}`)
        if (e.origin.kind !== 'unload') return { deny: '无法保存 Shell 输出，请稍后再退出控制台。' }
      } finally {
        pendingArchive = ''
      }
    }
    const result = await next(e)
    resetShell()
    $.ui.invalidate('ui.render')
    return result
  })

  on('session.end', async ($, e, next) => {
    await exitShell($, false)
    return next(e)
  })
}
