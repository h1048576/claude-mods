import { expect, test } from 'claude-code/testing'

const TOOL_USE_PROPS = {
  tool_use_id: 'tu_1',
  tool: 'Read',
  input: { file_path: 'a.ts' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
}

test('off：钩子放行，事件到达下层', { options: { mode: 'off' } }, async ($, on) => {
  let reached = false
  on('ui.render', { component: 'ToolUse' }, async ($inner, e) => {
    reached = true
    const { Box } = $inner.ui.resolve(e)

    return <Box />
  })

  const ui = await $.ui.mount({
    plugin: 'show-mode',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...TOOL_USE_PROPS },
  })

  expect(reached).toBe(true)
  await ui.unmount()
})

test('hidden：成功调用不绘制任何文本', { options: { mode: 'hidden' } }, async $ => {
  const ui = await $.ui.mount({
    plugin: 'show-mode',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...TOOL_USE_PROPS },
  })

  expect(await ui.find({ type: 'Text', text: /Read/ })).toBeUndefined()
  await ui.unmount()
})

test('Spinner：任何模式下都放行', { options: { mode: 'hidden' } }, async ($, on) => {
  let reached = false
  on('ui.render', { component: 'Spinner' }, async ($inner, e) => {
    reached = true
    const { Box } = $inner.ui.resolve(e)

    return <Box />
  })

  const ui = await $.ui.mount({
    plugin: 'show-mode',
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Swirling', message: null, suffix: '46s', mode: 'thinking' },
  })

  expect(reached).toBe(true)
  await ui.unmount()
})
