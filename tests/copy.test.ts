import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import * as env from '../hooks/dotenv'
import * as worktree from '../hooks/worktree'

const MAIN = '/repo/app'
const FEATURE = '/repo/app-feature'
const SOURCE = '# Stripe\nSTRIPE_KEY=sk_live_main1234567\nPORT=3000\n'

// A repo with a second worktree, files kept in memory by absolute path (a
// bare name is the main checkout's), and git answering for MAIN
function repo(on: Parameters<TestBody>[1], files: Record<string, string>): Record<string, string> {
  // The engine resolves a bare name against the test's own folder
  const abs = (path: string) => (path.startsWith('/repo/') ? path : `${MAIN}/${path.split('/').pop()}`)
  on('fs.list', () => ({ value: [{ name: '.env.local', kind: 'file', size: 1, mtimeMs: 1 }] }) as never)
  on('fs.read', ($, e) => {
    const text = files[abs(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files[abs(e.path)] !== undefined }))
  on('fs.write', ($, e) => {
    files[abs(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    const stdout =
      args === 'rev-parse --show-toplevel'
        ? `${MAIN}\n`
        : args === 'rev-parse --show-prefix'
          ? '\n'
          : args === 'worktree list --porcelain'
            ? `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${FEATURE}\nHEAD def\nbranch refs/heads/feature\n`
            : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return files
}

const copy = (input: Record<string, unknown>) => ({ tool: 'mcp__env__copy', from: '.env.local', ...input }) as never

describe('copy into another worktree', () => {
  test('a whole file into a worktree that has none is copied as-is, comments included', async ($, on) => {
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE })

    const res = await $.tool.call(copy({ to: '../app-feature/.env.local' }))
    expect(files[`${FEATURE}/.env.local`]).toBe(SOURCE)
    expect(String(res.result)).toContain('STRIPE_KEY, PORT')
    expect(String(res.result)).not.toContain('sk_live_main1234567')
  })

  test("into an existing file, the target's own values are kept unless overwrite is set", async ($, on) => {
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE, [`${FEATURE}/.env.local`]: 'PORT=4000\n' })

    const res = await $.tool.call(copy({ to: `${FEATURE}/.env.local` }))
    const lines = env.parse(files[`${FEATURE}/.env.local`] ?? '')
    expect(env.get(lines, 'PORT')).toBe('4000')
    expect(env.get(lines, 'STRIPE_KEY')).toBe('sk_live_main1234567')
    expect(String(res.result)).toContain("kept the target's own value: PORT")

    await $.tool.call(copy({ to: `${FEATURE}/.env.local`, overwrite: true }))
    expect(env.get(env.parse(files[`${FEATURE}/.env.local`] ?? ''), 'PORT')).toBe('3000')
  })

  test('one key still copies on its own, from a path as well as a name', async ($, on) => {
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE })

    await $.tool.call(copy({ from: `${MAIN}/.env.local`, to: '../app-feature/.env', key: 'PORT' }))
    expect(files[`${FEATURE}/.env`]).toBe('PORT=3000\n')
  })

  test('a folder that is not a worktree root, or a template, is refused and nothing is written', async ($, on) => {
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE })
    const before = Object.keys(files).length

    for (const to of ['/tmp/.env.local', '../app-feature/packages/.env.local', '.env.example']) {
      const res = await $.tool.call(copy({ to }))
      expect(String(res.result)).toMatch(/not the root|template/)
    }
    expect(Object.keys(files).length).toBe(before)
  })
})

describe('worktree paths', () => {
  test('resolve takes bare names as before and resolves .. against the session', async () => {
    expect(worktree.resolve('.env.local', MAIN, [])).toEqual({ path: '.env.local', label: '.env.local' })
    expect(worktree.resolve('../app-feature/./.env', MAIN, [MAIN, FEATURE])).toEqual({
      path: `${FEATURE}/.env`,
      label: `${FEATURE}/.env`,
    })
    expect('error' in worktree.resolve('../app-feature/notes.txt', MAIN, [MAIN, FEATURE])).toBe(true)
  })
})
