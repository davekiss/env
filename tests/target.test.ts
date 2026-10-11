import { describe, expect, test } from 'claude-code/testing'

import * as env from '../hooks/dotenv'
import { FEATURE, MAIN, repo } from './repo'

const ask = { tool: 'mcp__env__request', key: 'OPENAI_API_KEY', reason: 'AI annotations', steps: ['Copy it'] }

describe('a file path into another worktree', () => {
  test('generate writes into that worktree, not the main checkout', async ($, on) => {
    const files = repo(on, { [`${MAIN}/.env`]: 'PORT=3000\n', [`${FEATURE}/.env`]: 'PORT=3000\n' })

    await $.tool.call({ tool: 'mcp__env__generate', key: 'SESSION_SECRET', file: `${FEATURE}/.env` } as never)
    expect(env.get(env.parse(files[`${FEATURE}/.env`] ?? ''), 'SESSION_SECRET')).toBeDefined()
    expect(env.get(env.parse(files[`${MAIN}/.env`] ?? ''), 'SESSION_SECRET')).toBeUndefined()
  })

  test('request asks for the value in that worktree', async ($, on) => {
    repo(on, {})
    on('ui.open', { id: 'env' }, () => ({ value: { isPlaced: true } }))

    const res = await $.tool.call({ ...ask, file: '../app-feature/.env' } as never)
    expect(String(res.result)).toContain(`${FEATURE}/.env`)
  })

  test("a path outside this repo's worktrees is refused, not swapped for the default file", async ($, on) => {
    const files = repo(on, { [`${MAIN}/.env`]: 'PORT=3000\n' })

    const res = await $.tool.call({ tool: 'mcp__env__generate', key: 'SESSION_SECRET', file: '/tmp/elsewhere/.env' } as never)
    expect(String(res.result)).toContain('not the root of one of')
    expect(files[`${MAIN}/.env`]).toBe('PORT=3000\n')
  })
})
