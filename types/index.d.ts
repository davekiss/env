export type EnvEditing = { file: string; key: string | null }
export type EnvRequest = {
  key: string
  file: string
  reason: string
  steps: string[]
  url?: string
  format?: string
  pattern?: string
}
export type EnvFit = 'ok' | 'off' | null

declare module 'claude-code' {
  interface PluginState {
    env: {
      files: string[]
      active: string
      editing: EnvEditing | null
      revealed: string | null
      confirm: string | null
      request: EnvRequest | null
      fit: EnvFit
      rev: number
      flash: string | null
      isWaiting: boolean
    }
  }
}
