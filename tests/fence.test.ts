import { describe, expect, test } from 'claude-code/testing'

describe('tool fence', () => {
  test('Read of .env.local is denied, .env.example goes through', async ($, on) => {
    on('tool.call', () => ({ result: 'file contents' }))

    const denied = await $.tool.call({ tool: 'Read', file_path: '/repo/.env.local' })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('mcp__env__request')

    const allowed = await $.tool.call({ tool: 'Read', file_path: '/repo/.env.example' })
    expect(allowed.result).toBe('file contents')
  })
})
