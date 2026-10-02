import { describe, expect, test } from 'claude-code/testing'

const ask = { tool: 'mcp__env__request', key: 'CLOUDFLARE_ACCOUNT_ID', reason: 'API calls', steps: ['Copy it'] }

describe('request on a narrow terminal', () => {
  test('a pane left waiting tells Claude the card is above the prompt', async ($, on) => {
    on('ui.open', { id: 'env' }, () => ({ value: { isPlaced: false, reason: 'below 144 columns' } }))

    const res = await $.tool.call(ask as never)
    expect(String(res.result)).toContain('above the prompt')
    expect(String(res.result)).not.toContain('in the /env pane.')
  })

  test('a placed pane keeps the plain answer', async ($, on) => {
    on('ui.open', { id: 'env' }, () => ({ value: { isPlaced: true } }))

    const res = await $.tool.call(ask as never)
    expect(String(res.result)).toContain('in the /env pane.')
  })
})
