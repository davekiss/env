import { describe, expect, test } from 'claude-code/testing'

import * as env from '../hooks/dotenv'
import * as remote from '../hooks/remote'
import { MAIN, OUTSIDE, far, repo } from './repo'

const SOURCE = '# Stripe\nSTRIPE_KEY=sk_live_main1234567\nPORT=3000\n'
const SERVER = 'DATABASE_URL=postgres://server_secret_pw@db/app\nPORT=8080\n'

const copy = (input: Record<string, unknown>) => ({ tool: 'mcp__env__copy', ...input }) as never

describe('copy to and from another machine over ssh', () => {
  test("a remote file merges into a local one, the local file's own values kept", async ($, on) => {
    const world = far({ box: SERVER })
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE }, world)

    const res = await $.tool.call(copy({ from: 'box:~/app/.env', to: '.env.local' }))
    const lines = env.parse(files[`${MAIN}/.env.local`] ?? '')
    expect(env.get(lines, 'DATABASE_URL')).toBe('postgres://server_secret_pw@db/app')
    expect(env.get(lines, 'PORT')).toBe('3000')
    expect(String(res.result)).toContain('set: DATABASE_URL')
    expect(String(res.result)).not.toContain('server_secret_pw')
    expect(world.ran[0]?.argv.slice(0, 4)).toEqual(['ssh', '-o', 'BatchMode=yes', 'box'])
  })

  test('a local file goes to a remote one that does not exist yet as-is', async ($, on) => {
    const world = far({ 'deploy@box': undefined })
    repo(on, { [`${MAIN}/.env.local`]: SOURCE }, world)

    const res = await $.tool.call(copy({ from: '.env.local', to: 'deploy@box:/srv/app/.env' }))
    expect(world.hosts['deploy@box']).toBe(SOURCE)
    expect(world.ran.at(-1)?.argv[4]).toBe("umask 077 && cat > '/srv/app/.env'")
    expect(String(res.result)).not.toContain('sk_live_main1234567')
  })

  test('the user is asked once per host, and a no means nothing runs there', async ($, on) => {
    const world = far({ box: SERVER })
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE }, world)

    await $.tool.call(copy({ from: 'box:.env', to: '.env.local', key: 'DATABASE_URL' }))
    await $.tool.call(copy({ from: 'box:.env', to: '.env.local', key: 'PORT', as: 'SERVER_PORT' }))
    expect(world.asked).toHaveLength(1)
    expect(world.asked[0]).toContain('box')

    world.answer = "Don't allow"
    const before = files[`${MAIN}/.env.local`]
    const res = await $.tool.call(copy({ from: '.env.local', to: 'other:.env' }))
    expect(String(res.result)).toContain('declined')
    expect(world.ran.some(run => run.argv[3] === 'other')).toBe(false)
    expect(files[`${MAIN}/.env.local`]).toBe(before)
  })

  test('a path with spaces or quotes stays one quoted argument, ~/ still expanding', () => {
    expect(remote.writer({ host: 'box', path: "~/my app/it's/.env" })[4]).toBe(`umask 077 && cat > ~/'my app/it'\\''s/.env'`)
  })

  test('a host that ssh could read as an option is not treated as a host', async ($, on) => {
    const world = far()
    repo(on, { [`${MAIN}/.env.local`]: SOURCE }, world)

    await $.tool.call(copy({ from: '.env.local', to: '-oProxyCommand=touch:.env' }))
    expect(world.ran).toHaveLength(0)
    expect(remote.parse('-oProxyCommand=touch:.env')).toBeUndefined()
  })

  test('an ssh failure writes nothing and says how to check the connection', async ($, on) => {
    const world = far({ box: SERVER })
    world.status = 255
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE }, world)

    const res = await $.tool.call(copy({ from: 'box:.env', to: '.env.local' }))
    expect(files[`${MAIN}/.env.local`]).toBe(SOURCE)
    expect(String(res.result)).toContain('! ssh box true')
  })

  test('remote to remote is refused, so every value passes through a file the scrubber knows', async ($, on) => {
    const world = far({ a: SERVER, b: undefined })
    repo(on, {}, world)

    const res = await $.tool.call(copy({ from: 'a:.env', to: 'b:.env' }))
    expect(String(res.result)).toContain('local')
    expect(world.ran).toHaveLength(0)
  })
})

describe('copy to a folder outside the worktrees', () => {
  test('goes ahead once the user allows that folder', async ($, on) => {
    const world = far()
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE }, world)

    await $.tool.call(copy({ from: '.env.local', to: `${OUTSIDE}/.env` }))
    expect(files[`${OUTSIDE}/.env`]).toBe(SOURCE)
    expect(world.asked[0]).toContain(OUTSIDE)
  })

  test('is refused when the user says no', async ($, on) => {
    const world = far({}, "Don't allow")
    const files = repo(on, { [`${MAIN}/.env.local`]: SOURCE }, world)

    const res = await $.tool.call(copy({ from: '.env.local', to: `${OUTSIDE}/.env` }))
    expect(files[`${OUTSIDE}/.env`]).toBeUndefined()
    expect(String(res.result)).toContain('declined')
  })
})
