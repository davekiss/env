import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import * as env from '../hooks/dotenv'
import * as pull from '../hooks/pull'

const LOCAL = '.env.local'
const TMP = '/tmp/env-pull-test'

type World = { files: Record<string, string>; ran: string[][]; asked: string[] }

// A project whose files live in memory, a user who answers any dialog with
// `answer`, and CLIs that behave like the real ones: vercel writes the file
// it's given, doppler prints KEY=value lines, op prints one value
function project(on: Parameters<TestBody>[1], local: string, answer = 'Keep mine'): World {
  const world: World = { files: { [LOCAL]: local }, ran: [], asked: [] }
  const name = (path: string) => (path.endsWith(LOCAL) ? LOCAL : path)
  on('fs.list', () => ({ value: [{ name: LOCAL, kind: 'file', size: 1, mtimeMs: 1 }] }) as never)
  on('fs.read', ($, e) => {
    const text = world.files[name(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', ($, e) => {
    world.files[name(e.path)] = e.text
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    world.asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: answer } } } as never
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    world.ran.push(argv)
    let stdout = ''
    if (argv[0] === 'mktemp') stdout = `${TMP}\n`
    if (argv[0] === 'vercel') world.files[argv[3] ?? ''] = 'API_URL=https://api.test\nVERCEL_OIDC_TOKEN=oidc_token_value\n'
    if (argv[0] === 'doppler') stdout = 'STRIPE_KEY=sk_live_fromdoppler1\nSENTRY_DSN=https://dsn.test/1\n'
    if (argv[0] === 'op') stdout = 'op_secret_value\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return world
}

describe('pull writes what a CLI gives into the env file', () => {
  test('KEY=value lines on stdout are written, and the result names keys, not values', async ($, on) => {
    const world = project(on, 'PORT=3000\n')

    const res = await $.tool.call({ tool: 'mcp__env__pull', argv: ['doppler', 'secrets', 'download', '--no-file', '--format', 'env'] } as never)
    const file = env.parse(world.files[LOCAL] ?? '')
    expect(env.get(file, 'STRIPE_KEY')).toBe('sk_live_fromdoppler1')
    expect(env.get(file, 'PORT')).toBe('3000')
    expect(String(res.result)).toContain('set: STRIPE_KEY, SENTRY_DSN')
    expect(String(res.result)).not.toContain('sk_live_fromdoppler1')
  })

  test('a CLI that writes a file gets a temp path, which is read back and removed', async ($, on) => {
    const world = project(on, '')

    await $.tool.call({ tool: 'mcp__env__pull', argv: ['vercel', 'env', 'pull', pull.OUT, '--yes'], keys: ['API_URL'] } as never)
    expect(world.ran.find(argv => argv[0] === 'vercel')).toEqual(['vercel', 'env', 'pull', `${TMP}/pulled.env`, '--yes'])
    expect(world.ran.at(-1)).toEqual(['rm', '-rf', TMP])
    const file = env.parse(world.files[LOCAL] ?? '')
    expect(env.get(file, 'API_URL')).toBe('https://api.test')
    expect(env.get(file, 'VERCEL_OIDC_TOKEN')).toBeUndefined()
  })

  test('one printed value is stored under key, without its trailing newline', async ($, on) => {
    const world = project(on, '')

    await $.tool.call({ tool: 'mcp__env__pull', argv: ['op', 'read', 'op://Dev/Stripe/key'], key: 'STRIPE_KEY' } as never)
    expect(env.get(env.parse(world.files[LOCAL] ?? ''), 'STRIPE_KEY')).toBe('op_secret_value')
  })

  test('a local value is kept unless overwrite is passed and the user agrees', async ($, on) => {
    const kept = project(on, 'STRIPE_KEY=sk_test_mine12345\n')
    const res = await $.tool.call({ tool: 'mcp__env__pull', argv: ['op', 'read', 'op://x'], key: 'STRIPE_KEY' } as never)
    expect(env.get(env.parse(kept.files[LOCAL] ?? ''), 'STRIPE_KEY')).toBe('sk_test_mine12345')
    expect(String(res.result)).toContain('overwrite: true')
    expect(kept.asked).toEqual([])
  })

  test('overwrite asks first, and declining keeps the local value', async ($, on) => {
    const world = project(on, 'STRIPE_KEY=sk_test_mine12345\n', 'Keep mine')
    await $.tool.call({ tool: 'mcp__env__pull', argv: ['op', 'read', 'op://x'], key: 'STRIPE_KEY', overwrite: true } as never)
    expect(world.asked.length).toBe(1)
    expect(env.get(env.parse(world.files[LOCAL] ?? ''), 'STRIPE_KEY')).toBe('sk_test_mine12345')
  })

  test('overwrite replaces the value once the user agrees', async ($, on) => {
    const world = project(on, 'STRIPE_KEY=sk_test_mine12345\n', 'Replace them')
    await $.tool.call({ tool: 'mcp__env__pull', argv: ['op', 'read', 'op://x'], key: 'STRIPE_KEY', overwrite: true } as never)
    expect(env.get(env.parse(world.files[LOCAL] ?? ''), 'STRIPE_KEY')).toBe('op_secret_value')
  })

  test('a CLI outside the allowlist never runs', async ($, on) => {
    const world = project(on, '')
    const res = await $.tool.call({ tool: 'mcp__env__pull', argv: ['cat', '/etc/secrets'] } as never)
    expect(String(res.result)).toContain('not one of them')
    expect(world.ran).toEqual([])
  })
})

describe('pull helpers', () => {
  test('check refuses placeholders, and a file with a single key', async () => {
    expect('error' in pull.check(['vercel', 'env', 'pull', '--token={{TOKEN}}'], undefined, undefined)).toBe(true)
    expect('error' in pull.check(['vercel', 'env', 'pull', pull.OUT], 'API_URL', undefined)).toBe(true)
  })

  test('merge fills an empty key instead of keeping it', async () => {
    const merged = pull.merge(env.parse('API_URL=\n'), { API_URL: 'https://api.test' }, false)
    expect(merged.added).toEqual(['API_URL'])
    expect(env.get(merged.lines, 'API_URL')).toBe('https://api.test')
  })
})
