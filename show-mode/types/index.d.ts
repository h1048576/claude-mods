export type ShowMode = 'off' | 'hidden'

// 保存已落地的文件新增/修改 diff，供 /show-mode view 回看。
export interface StoredDiff {
  id: number
  at: number
  filePath: string
  action: 'create' | 'update'
  tool: string
  diff: string
}

// hidden 模式下保存的思考、过程叙述，以及工具/技能调用。
export interface StoredThought {
  id: number
  at: number
  kind: 'thinking' | 'narration' | 'tool' | 'skill'
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'show-mode': {
      mode: ShowMode | null
      diffs: StoredDiff[]
      thoughts: StoredThought[]
      processRows: Record<string, boolean>
    }
  }
}
