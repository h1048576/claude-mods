import type { Elements, TextProps } from 'claude-code'

export type OutputRun = { text: string; style: TextProps }
export type OutputLine = OutputRun[]

export const OUTPUT_LIMIT = 50_000
export const OUTPUT_LINE_LIMIT = 200
const RUN_LIMIT = 4_000
const ANSI_COLORS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'gray', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
]

const paletteColor = (value: number): string | undefined => {
  if (!Number.isInteger(value) || value < 0 || value > 255) return undefined
  if (value < 16) return ANSI_COLORS[value]
  if (value >= 232) {
    const channel = (8 + (value - 232) * 10).toString(16).padStart(2, '0')
    return `#${channel}${channel}${channel}`
  }
  const index = value - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return '#' + [Math.floor(index / 36), Math.floor(index / 6) % 6, index % 6]
    .map(channel => levels[channel]!.toString(16).padStart(2, '0')).join('')
}

// 只采用程序明确给出的 SGR 颜色与样式，不根据文件名或输出文字猜测。
const applyStyle = (style: TextProps, sequence: string) => {
  const values = (sequence === '' ? ['0'] : sequence.split(';')).map(Number)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    if (value === 0) {
      for (const key of Object.keys(style)) delete style[key as keyof TextProps]
    } else if (value === 1) style.bold = true
    else if (value === 2) style.dimColor = true
    else if (value === 3) style.italic = true
    else if (value === 4) style.underline = true
    else if (value === 7) style.inverse = true
    else if (value === 9) style.strikethrough = true
    else if (value === 22) { delete style.bold; delete style.dimColor }
    else if (value === 23) delete style.italic
    else if (value === 24) delete style.underline
    else if (value === 27) delete style.inverse
    else if (value === 29) delete style.strikethrough
    else if (value === 39) delete style.color
    else if (value === 49) delete style.backgroundColor
    else if (value >= 30 && value <= 37) style.color = ANSI_COLORS[value - 30]
    else if (value >= 90 && value <= 97) style.color = ANSI_COLORS[value - 90 + 8]
    else if (value >= 40 && value <= 47) style.backgroundColor = ANSI_COLORS[value - 40]
    else if (value >= 100 && value <= 107) style.backgroundColor = ANSI_COLORS[value - 100 + 8]
    else if (value === 38 || value === 48) {
      let color: string | undefined
      if (values[index + 1] === 5 && values[index + 2] !== undefined) {
        color = paletteColor(values[index + 2]!)
        index += 2
      } else if (values[index + 1] === 2 && values.length >= index + 5) {
        const channels = values.slice(index + 2, index + 5)
        if (channels.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
          color = '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('')
        }
        index += 4
      }
      if (color !== undefined) style[value === 38 ? 'color' : 'backgroundColor'] = color
    }
  }
}

export const parseOutput = (text: string) => {
  // 先限制原始数据，再移除光标移动、OSC 等控制序列；颜色在 Text 上渲染。
  const rawLimit = OUTPUT_LIMIT * 8
  const source = text.slice(0, rawLimit)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g,
      sequence => /^\x1b\[[\d;]*m$/.test(sequence) ? sequence : '')
    .replace(/\x1b(?!\[[\d;]*m)/g, '')
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f]/g, '')
  const lines: OutputLine[] = [[]]
  const style: TextProps = {}
  let length = 0
  let runs = 0
  let truncated = text.length > rawLimit

  const append = (value: string) => {
    const parts = value.split('\n')
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        if (lines.length >= OUTPUT_LINE_LIMIT || length >= OUTPUT_LIMIT) {
          truncated = true
          return false
        }
        lines.push([])
        length += 1
      }
      const remaining = OUTPUT_LIMIT - length
      let piece = part.slice(0, remaining)
      // 不在 UTF-16 代理对中间截断。
      if (piece.length < part.length && /[\uD800-\uDBFF]$/.test(piece)) piece = piece.slice(0, -1)
      if (piece !== '') {
        const line = lines[lines.length - 1]!
        const nextStyle = runs < RUN_LIMIT ? { ...style } : {}
        const previous = line[line.length - 1]
        if (previous && JSON.stringify(previous.style) === JSON.stringify(nextStyle)) previous.text += piece
        else { line.push({ text: piece, style: nextStyle }); runs += 1 }
        length += piece.length
      }
      if (piece.length < part.length) { truncated = true; return false }
    }
    return true
  }

  let offset = 0
  let stopped = false
  for (const match of source.matchAll(/\x1b\[([\d;]*)m/g)) {
    if (!append(source.slice(offset, match.index))) { stopped = true; break }
    applyStyle(style, match[1]!)
    offset = match.index + match[0].length
  }
  if (!stopped) append(source.slice(offset))
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop()
  return { lines, truncated }
}

export const lineLength = (line: OutputLine) => line.reduce((total, run) => total + run.text.length, 0)

const colorCodes = (color: string | undefined, background: boolean) => {
  if (color === undefined) return []
  const index = ANSI_COLORS.indexOf(color)
  if (index !== -1) return [(index < 8 ? (background ? 40 : 30) : (background ? 100 : 90)) + index % 8]
  if (/^#[\da-f]{6}$/i.test(color)) {
    return [background ? 48 : 38, 2, ...[1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16))]
  }
  return []
}

// 本地存档带颜色，后续重绘/插件重载无需依赖内存中的历史。
export const serializeOutput = (lines: OutputLine[]) => {
  return lines.map(line => line.map(run => {
    const codes = [
      ...(run.style.bold ? [1] : []), ...(run.style.dimColor ? [2] : []),
      ...(run.style.italic ? [3] : []), ...(run.style.underline ? [4] : []),
      ...(run.style.inverse ? [7] : []), ...(run.style.strikethrough ? [9] : []),
      ...colorCodes(run.style.color, false), ...colorCodes(run.style.backgroundColor, true),
    ]
    return codes.length === 0 ? run.text : `\x1b[${codes.join(';')}m${run.text}\x1b[0m`
  }).join('')).join('\n')
}

export const renderOutput = (elements: Pick<Elements['terminal'], 'Box' | 'Text'>, lines: OutputLine[]) => {
  const { Box, Text } = elements
  return Box({
    flexDirection: 'column',
    children: lines.map(line => Text({
      wrap: 'wrap',
      children: line.length === 0 ? [' '] : line.flatMap(run =>
        (run.text.match(/.{1,4000}/gu) ?? []).map(piece => Text({ ...run.style, children: piece }))),
    })),
  })
}
