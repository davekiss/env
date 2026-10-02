import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { EnvEditing, EnvFit, EnvRequest } from '../types'
import * as env from './dotenv'
import { bashReason, grepReason, isProtectedPath } from './guard'
import * as push from './push'

const PANE = 'env'
const TOOL = 'mcp__env__'

const files = atom({ plugin: 'env', key: 'files' } as const, [] as string[])
const active = atom({ plugin: 'env', key: 'active' } as const, '')
const editing = atom({ plugin: 'env', key: 'editing' } as const, null as EnvEditing | null)
const revealed = atom({ plugin: 'env', key: 'revealed' } as const, null as string | null)
const confirm = atom({ plugin: 'env', key: 'confirm' } as const, null as string | null)
const request = atom({ plugin: 'env', key: 'request' } as const, null as EnvRequest | null)
const fit = atom({ plugin: 'env', key: 'fit' } as const, null as EnvFit)
const rev = atom({ plugin: 'env', key: 'rev' } as const, 0)
const flash = atom({ plugin: 'env', key: 'flash' } as const, null as string | null)
// The pane is open but the surface hasn't placed it (opened unasked on a
// narrow terminal), so the request card draws above the prompt instead
const isWaiting = atom({ plugin: 'env', key: 'isWaiting' } as const, false)

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

const DENY =
  'env: .env files are edited by the user in the /env pane, and their values never enter ' +
  'this conversation. Use mcp__env__list to see keys and what each value looks like, ' +
  'mcp__env__request to ask the user for a value, mcp__env__generate for a random secret, and ' +
  'mcp__env__push to send a value to a hosting service through its CLI. ' +
  'Programs that load .env (npm run dev, tests) still run normally.'

type Engine = EngineInterface

// Value -> key, for the scrubber. Rebuilt whenever an env file changes.
let index: env.Index = []
let signature = ''

function rank(name: string): number {
  if (env.isTemplate(name)) return 9
  if (name === '.env') return 0
  if (name === '.env.local') return 1
  return 2
}

async function load($: Engine, file: string): Promise<env.Line[]> {
  try {
    return env.parse(await $.fs.read(file))
  } catch {
    return []
  }
}

// Reads every env file in the project root, rebuilds the scrub index and
// redraws the pane. Cheap enough to run on every change.
async function refresh($: Engine): Promise<void> {
  const listing = await $.fs.list().catch(() => [])
  const names = listing
    .filter(entry => entry.kind === 'file' && env.isEnvFile(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))

  const parsed: Record<string, env.Line[]> = {}
  for (const name of names) parsed[name] = await load($, name)
  index = env.buildIndex(parsed)
  signature = listing
    .filter(entry => env.isEnvFile(entry.name))
    .map(entry => `${entry.name}:${entry.mtimeMs}:${entry.size}`)
    .join('|')

  await update($, files, () => names)
  await update($, active, current => (names.includes(current) ? current : (names[0] ?? '')))
  await update($, rev, n => n + 1)
}

async function save($: Engine, file: string, lines: env.Line[]): Promise<void> {
  await $.fs.write(file, env.serialize(lines))
  await refresh($)
}

async function defaultFile($: Engine): Promise<string> {
  const names = await read($, files)
  return names.includes('.env.local') ? '.env.local' : names.includes('.env') ? '.env' : '.env.local'
}

function asFile(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const name = String(value)
  return env.isEnvFile(name) ? name : undefined
}

function fitOf(value: string, pattern: string | undefined): EnvFit {
  if (value === '' || !pattern) return null
  try {
    return new RegExp(pattern).test(value.trim()) ? 'ok' : 'off'
  } catch {
    return null
  }
}

async function isIgnored($: Engine, file: string): Promise<boolean> {
  const text = await $.fs.read('.gitignore').catch(() => '')
  return text.split(/\r?\n/).some(row => {
    const pattern = row.trim().replace(/^\//, '')
    if (pattern === '' || pattern.startsWith('#') || pattern.startsWith('!')) return false
    const glob = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    return glob.test(file)
  })
}

// Ends an open request without a value and tells Claude why, so it doesn't
// sit waiting for a message that will never come
async function abandon($: Engine, how: 'skipped' | 'closed the pane without setting'): Promise<void> {
  const asked = await read($, request)
  if (!asked) return
  await update($, request, () => null)
  await update($, fit, () => null)
  void $.prompt.submit({
    text: `[env] The user ${how} ${asked.key}, so it is still not set in ${asked.file}. Carry on without it, or ask what they'd like to do.`,
  })
}

type Block = { type: string; [field: string]: unknown }

function scrubBlock(block: Block): Block {
  if (block.type === 'text' && typeof block.text === 'string') {
    const text = env.scrub(block.text, index)
    return text === block.text ? block : { ...block, text }
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') {
      const content = env.scrub(block.content, index)
      return content === block.content ? block : { ...block, content }
    }
    if (Array.isArray(block.content)) {
      const content: Block[] = (block.content as Block[]).map(scrubBlock)
      return content.every((part, i) => part === (block.content as unknown[])[i]) ? block : { ...block, content }
    }
  }
  return block
}

async function store($: Engine, target: string, key: string, value: string): Promise<void> {
  await save($, target, env.set(await load($, target), key, value))
  await update($, editing, () => null)
  await update($, flash, () => `Saved ${key} in ${target}`)
  const wanted = await read($, request)
  if (wanted && wanted.key === key && wanted.file === target) {
    await update($, request, () => null)
    await update($, fit, () => null)
    void $.prompt.submit({ text: `[env] ${key} is now set in ${target}. Continue.` })
  }
}

// The card Claude's request draws: what, why, where to get it, and the
// field to paste into, readable at a glance. In the pane, or in the band
// above the prompt while the pane waits for a wider terminal.
async function requestCard($: Engine, ui: ElementTable<'terminal' | 'desktop'>, asked: EnvRequest, where: 'pane' | 'band') {
  const { Box, Text, Button, Input, Markdown } = ui
  const pasted = await read($, fit)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={where === 'pane' ? 1 : 0}>
      <Text bold color="yellow">
        Claude needs a value
      </Text>
      <Box gap={1} marginTop={1}>
        <Text bold>{asked.key}</Text>
        <Text dimColor>→ {asked.file}</Text>
      </Box>
      {asked.reason !== '' && <Text wrap="wrap">{asked.reason}</Text>}

      {asked.steps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {asked.steps.map((step, i) => (
            <Box key={`step:${i}`} gap={1}>
              <Text bold color="yellow">
                {String(i + 1)}.
              </Text>
              <Text wrap="wrap">{step}</Text>
            </Box>
          ))}
        </Box>
      )}

      {asked.url && (
        <Box gap={1} marginTop={1}>
          <Markdown text={`[${asked.url}](${asked.url})`} />
          <Button
            key="copy-url"
            label="copy link"
            plain
            dimColor
            onPress={press => void $.ui.copy({ text: asked.url ?? '', surface: press.surface })}
          />
        </Box>
      )}
      {asked.format && <Text dimColor>Looks like: {asked.format}</Text>}

      <Box marginTop={1}>
        <Input
          key="request"
          label="Paste ▸ "
          placeholder={`${asked.key}, then Enter`}
          submitLabel="save"
          autoFocus
          onInput={value => void update($, fit, () => fitOf(value, asked.pattern))}
          onSubmit={value => void store($, asked.file, asked.key, value.trim())}
        />
      </Box>
      {pasted === 'ok' && <Text color="green">✓ looks right</Text>}
      {pasted === 'off' && <Text color="red">✗ doesn't look like {asked.format ?? 'the expected format'}; Enter still saves</Text>}
      <Box gap={1} marginTop={1}>
        <Button key="skip" label="skip for now" plain dimColor onPress={() => void abandon($, 'skipped')} />
        {where === 'band' && (
          <Button
            key="open-pane"
            label="open /env pane"
            plain
            dimColor
            onPress={async () => {
              const opened = await $.ui.open({ id: PANE, title: 'env', focus: true })
              await update($, isWaiting, () => !opened.isPlaced)
            }}
          />
        )}
      </Box>
      {where === 'band' && <Text dimColor>Click the field or press ctrl+x tab to paste.</Text>}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)

    await $.command.register({
      name: 'env',
      description: 'Edit .env files without showing values to Claude',
      immediate: true,
    })

    await $.tool.register({
      name: 'list',
      description:
        "Lists the project's .env files and their keys, with what each value looks like (set or empty, " +
        'kind, length, a known prefix such as sk_live_) but never the value itself, plus keys missing ' +
        'compared with .env.example. Use this instead of reading .env files, which is blocked.',
      inputSchema: {
        type: 'object',
        properties: { file: { type: 'string', description: 'One env file, e.g. .env.local. Default: all.' } },
      },
    })
    await $.tool.register({
      name: 'request',
      description:
        'Asks the user to paste the value of one env variable into a card in the /env pane. You never ' +
        'see the value. The user may be moving fast, so make the card easy to act on: give the exact ' +
        'steps to find the value (where to click, what the field is labelled), the URL of the page it ' +
        'lives on, and what a valid value looks like. After calling this, stop and wait: you get a ' +
        'message once the value is saved, skipped, or the pane is closed.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The variable name the code reads, e.g. CLOUDFLARE_ACCOUNT_ID' },
          file: { type: 'string', description: 'Default .env.local, else .env' },
          reason: { type: 'string', description: 'Why it is needed, in under 12 words' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description:
              '2-5 short imperative steps, one action each, naming the exact labels on screen. ' +
              'E.g. ["Open the Cloudflare dashboard", "Pick any domain", "Copy Account ID from the right sidebar"]',
          },
          url: { type: 'string', description: 'The https page where the value can be found or created' },
          format: { type: 'string', description: 'What a valid value looks like, e.g. "32-character hex"' },
          pattern: { type: 'string', description: 'Optional regex the value should match, to flag a bad paste' },
        },
        required: ['key', 'reason', 'steps'],
      },
    })
    await $.tool.register({
      name: 'generate',
      description:
        'Sets an env variable to a new random secret (session secrets, signing keys, webhook ' +
        'secrets you control). The value is written to the file and never returned. Refuses to ' +
        'replace an existing value unless overwrite is true.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          file: { type: 'string' },
          bytes: { type: 'number', description: 'Random bytes, default 32' },
          format: { type: 'string', enum: ['base64url', 'hex'] },
          overwrite: { type: 'boolean' },
        },
        required: ['key'],
      },
    })
    await $.tool.register({
      name: 'copy',
      description: 'Copies a value from one env file to another (optionally under a new key) without reading it.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          as: { type: 'string', description: 'Key name in the target file. Default: same key.' },
        },
        required: ['key', 'from', 'to'],
      },
    })
    await $.tool.register({
      name: 'remove',
      description:
        'Removes a key from an env file by commenting it out, so the user can restore it. Ask the user before removing keys.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, file: { type: 'string' } },
        required: ['key', 'file'],
      },
    })

    await $.tool.register({
      name: 'push',
      description:
        "Sends env values to a hosting service by running that service's own CLI, with {{KEY}} in argv " +
        'or stdin replaced by the value from the env file. You never see the value, and the user ' +
        'approves the command (shown with placeholders) before it runs. Prefer stdin, since arguments ' +
        `show in the process list. Only these CLIs run: ${push.CLIS.join(', ')}. Examples: ` +
        '{argv: ["vercel", "env", "add", "STRIPE_KEY", "production"], stdin: "{{STRIPE_KEY}}"}; ' +
        '{argv: ["gh", "secret", "set", "STRIPE_KEY"], stdin: "{{STRIPE_KEY}}"}; ' +
        '{argv: ["wrangler", "secret", "put", "STRIPE_KEY"], stdin: "{{STRIPE_KEY}}"}; ' +
        '{argv: ["fly", "secrets", "import"], stdin: "STRIPE_KEY={{STRIPE_KEY}}"}. ' +
        'Run one command per call. Commands that need no env value belong in Bash.',
      inputSchema: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            description: 'The command and its arguments, the CLI first. No shell: no pipes, quoting or $VARS.',
          },
          stdin: { type: 'string', description: 'Text written to the command\'s stdin, e.g. "{{STRIPE_KEY}}"' },
          file: { type: 'string', description: 'The env file the values come from. Default .env.local, else .env' },
        },
        required: ['argv'],
      },
    })

    // Notice edits made outside the pane (another editor, a script)
    $.clock.every(2000, () => {
      void $.fs.list().then(listing => {
        const now = listing
          .filter(entry => env.isEnvFile(entry.name))
          .map(entry => `${entry.name}:${entry.mtimeMs}:${entry.size}`)
          .join('|')
        if (now !== signature) return refresh($)
      })
      // A waiting pane is placed once the terminal widens to its floor
      void $.ui.panes().then(async panes => {
        const pane = panes.find(p => p.id === PANE)
        const waiting = pane !== undefined && !pane.isPlaced
        if (waiting !== (await read($, isWaiting))) await update($, isWaiting, () => waiting)
      })
    })

    return next(e)
  })

  on('command.run', { command: 'env' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'env', focus: true })
    await update($, isWaiting, () => !opened.isPlaced)
    return { text: 'Opened the env pane.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isWaiting, () => false)
      if (e.origin.kind === 'person') await abandon($, 'closed the pane without setting')
    }
    return next(e)
  })

  // The fence: keep the built-in tools away from the raw files
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(TOOL)) return next(e)
    const input = e as unknown as Record<string, unknown>

    if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && isProtectedPath(input.file_path)) {
      return { deny: DENY }
    }
    if (tool === 'Grep') {
      const reason = grepReason(input)
      if (reason) return { deny: `${DENY} (Blocked because ${reason}.)` }
    }
    if (tool === 'Bash' && typeof input.command === 'string') {
      const reason = bashReason(input.command)
      if (reason) return { deny: `${DENY} (Blocked because ${reason}.)` }
    }
    return next(e)
  })

  // The backstop: any known value that reaches the conversation by any route
  // is replaced with [env:KEY] before the row is stored or sent
  on('session.append', ($, e, next) => {
    if (index.length === 0) return next(e)
    const content = e.message.content.map(scrubBlock)
    const isChanged = content.some((block, i) => block !== e.message.content[i])
    return isChanged ? next({ ...e, message: { ...e.message, content } }) : next(e)
  })

  on('session.send', ($, e, next) =>
    index.length === 0 ? next(e) : next({ ...e, text: env.scrub(e.text, index) }),
  )

  on('tool.call', { tool: 'mcp__env__list' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    await refresh($)
    const names = await read($, files)
    const wanted = input.file === undefined ? names : names.filter(name => name === input.file)
    if (wanted.length === 0) {
      return { result: names.length === 0 ? 'No .env files in the project root.' : `No such file. Files: ${names.join(', ')}` }
    }

    const template = names.find(env.isTemplate)
    const templateKeys = template ? env.entries(await load($, template)).map(entry => entry.key) : []
    const out: string[] = []
    for (const name of wanted) {
      const list = env.entries(await load($, name))
      out.push(`${name} (${list.length} keys${env.isTemplate(name) ? ', template' : ''})`)
      for (const entry of list) {
        const v = entry.value
        const look = v === '' ? 'empty' : `${env.kind(v)}, ${v.length} chars, looks like ${env.shape(v)}`
        out.push(`  ${entry.key}: ${look}`)
      }
      if (!env.isTemplate(name) && templateKeys.length > 0) {
        const have = new Set(list.map(entry => entry.key))
        const missing = templateKeys.filter(key => !have.has(key))
        if (missing.length > 0) out.push(`  missing compared with ${template}: ${missing.join(', ')}`)
      }
    }
    out.push('Values are hidden by design. Use mcp__env__request to have the user set one.')
    return { result: out.join('\n') }
  })

  on('tool.call', { tool: 'mcp__env__request' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const key = String(input.key ?? '')
    if (!KEY_NAME.test(key)) return { result: `"${key}" is not a valid env key name.` }
    const file = asFile(input.file) ?? (await defaultFile($))
    const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined)
    const steps = Array.isArray(input.steps) ? input.steps.map(step => String(step).slice(0, 160)).slice(0, 6) : []
    const url = text(input.url, 300)

    await update($, request, () => ({
      key,
      file,
      reason: text(input.reason, 200) ?? '',
      steps,
      url: url && /^https?:\/\//.test(url) ? url : undefined,
      format: text(input.format, 80),
      pattern: text(input.pattern, 200),
    }))
    await update($, fit, () => null)
    await update($, active, () => file)
    await update($, editing, () => null)
    // Opened by Claude, not the person, so a narrow terminal leaves the pane
    // waiting undrawn; the card then shows in the band above the prompt
    const opened = await $.ui.open({ id: PANE, title: 'env', focus: true })
    await update($, isWaiting, () => !opened.isPlaced)
    const wait = 'Stop here and wait; you will get a message once it is saved, skipped or the pane is closed.'
    if (!opened.isPlaced) {
      $.ui.toast(`Claude needs ${key}: paste it above the prompt`)
      return {
        result:
          `The terminal is too narrow for the /env pane to open on its own, so the request for ${key} (${file}) ` +
          `shows as a card above the prompt instead. Tell the user in one line to paste it there, or type /env ` +
          `to open the full pane. ${wait}`,
      }
    }
    $.ui.toast(`Claude needs ${key}`)
    return { result: `Asked the user to set ${key} in ${file} in the /env pane. ${wait}` }
  })

  on('tool.call', { tool: 'mcp__env__generate' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const key = String(input.key ?? '')
    if (!KEY_NAME.test(key)) return { result: `"${key}" is not a valid env key name.` }
    const file = asFile(input.file) ?? (await defaultFile($))
    const bytes = Math.min(128, Math.max(16, Number(input.bytes ?? 32) || 32))
    const format = input.format === 'hex' ? 'hex' : 'base64url'
    const lines = await load($, file)
    if (env.get(lines, key) && input.overwrite !== true) {
      return { result: `${key} already has a value in ${file}. Pass overwrite: true to replace it (confirm with the user first).` }
    }
    await save($, file, env.set(lines, key, env.randomSecret(bytes, format)))
    $.ui.toast(`Claude generated ${key} in ${file}`)
    return { result: `Set ${key} in ${file} to ${bytes} random bytes (${format}). The value is not shown.` }
  })

  on('tool.call', { tool: 'mcp__env__copy' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const key = String(input.key ?? '')
    const target = String(input.as ?? key)
    const from = asFile(input.from)
    const to = asFile(input.to)
    if (!from || !to || !KEY_NAME.test(target)) return { result: 'from and to must be env files, and the key a valid name.' }
    const value = env.get(await load($, from), key)
    if (value === undefined) return { result: `${key} is not set in ${from}.` }
    await save($, to, env.set(await load($, to), target, value))
    return { result: `Copied ${key} from ${from} to ${to}${target === key ? '' : ` as ${target}`}.` }
  })

  on('tool.call', { tool: 'mcp__env__remove' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const key = String(input.key ?? '')
    const file = asFile(input.file)
    if (!file) return { result: 'file must be an env file.' }
    const lines = await load($, file)
    if (env.get(lines, key) === undefined) return { result: `${key} is not in ${file}.` }
    await save($, file, env.commentOut(lines, key, `removed by Claude; uncomment to restore`))
    return { result: `Commented out ${key} in ${file}.` }
  })

  on('tool.call', { tool: 'mcp__env__push' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const plan = push.check(input.argv, input.stdin)
    if ('error' in plan) return { result: plan.error }
    const file = asFile(input.file) ?? (await defaultFile($))
    const cli = plan.argv[0] ?? ''

    const lines = await load($, file)
    const values: Record<string, string> = {}
    for (const key of plan.keys) {
      const value = env.get(lines, key)
      if (value) values[key] = value
    }
    const missing = plan.keys.filter(key => values[key] === undefined)
    if (missing.length > 0) {
      return { result: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in ${file}. Use mcp__env__request to have the user set ${missing.length === 1 ? 'it' : 'them'} first.` }
    }

    const command = push.shown(plan)
    const yes = 'Run it'
    const answer = await $.ui
      .ask(`Run \`${command}\` with ${plan.keys.join(', ')} filled in from ${file}?`, {
        header: 'env',
        options: [yes, "Don't run it"],
      })
      .catch(() => null)
    if (answer !== yes) {
      const said = answer && answer !== "Don't run it" ? ` They said: ${env.scrub(answer, index)}` : ''
      return { result: `The user did not approve \`${command}\`, so nothing ran.${said}` }
    }

    const ran = await $.process
      .run(
        plan.argv.map(arg => push.fill(arg, values)),
        { stdin: plan.stdin === undefined ? undefined : push.fill(plan.stdin, values), timeoutMs: 120_000 },
      )
      .catch((error: unknown) => ({ error: push.redact(String(error), values) }))
    if ('error' in ran) {
      return { result: `\`${command}\` could not run: ${ran.error}. Is ${cli} installed and on PATH?` }
    }

    const clean = (text: string) => push.tail(push.redact(env.scrub(text, index), values))
    const out = [`\`${command}\` exited ${ran.exitCode}.`]
    if (ran.stdout.trim()) out.push(`stdout:\n${clean(ran.stdout)}`)
    if (ran.stderr.trim()) out.push(`stderr:\n${clean(ran.stderr)}`)
    if (ran.exitCode !== 0) {
      out.push(`If ${cli} isn't logged in or linked, ask the user to run \`! ${cli} login\` (or link the project) and try again.`)
    } else {
      $.ui.toast(`Sent ${plan.keys.join(', ')} with ${cli}`)
    }
    return { result: out.join('\n') }
  })

  // While the pane waits for a wider terminal, Claude's request shows here
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    if (e.props.hasSurvey || !(await read($, isWaiting))) return next(e)
    const asked = await read($, request)
    if (!asked) return next(e)
    // isWaiting trails the surface by up to a poll; ask the surface itself
    // so the card leaves the moment the pane is placed
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (!pane || pane.isPlaced) return next(e)
    return requestCard($, $.ui.resolve(e), asked, 'band')
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>Open a terminal or the desktop app to edit env files.</Text>
    }
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input } = ui

    await read($, rev)
    const names = await read($, files)
    const file = await read($, active)
    const edit = await read($, editing)
    const shown = await read($, revealed)
    const asked = await read($, request)
    const pending = await read($, confirm)
    const note = await read($, flash)

    const lines = file ? await load($, file) : []
    const list = env.entries(lines)
    const template = names.find(env.isTemplate)
    const isTemplate = env.isTemplate(file)
    const missing =
      template && !isTemplate
        ? env.entries(await load($, template)).map(entry => entry.key).filter(key => !list.some(entry => entry.key === key))
        : []
    const isUnignored = file !== '' && !isTemplate && !(await isIgnored($, file))
    const keyWidth = Math.min(32, Math.max(8, ...list.map(entry => entry.key.length)) + 2)

    const say = (text: string | null) => update($, flash, () => text)

    const card = asked && (await requestCard($, ui, asked, 'pane'))

    const valueEditor = (key: string) => (
      <Box flexDirection="column" marginBottom={1}>
        <Input
          key="value"
          label={`${key} = `}
          placeholder="paste the value, Enter saves"
          submitLabel="save"
          autoFocus
          onSubmit={value => void store($, file, key, value)}
        />
        <Box gap={1}>
          <Button key="gen" label="generate random" onPress={() => void store($, file, key, env.randomSecret(32, 'base64url'))} />
          <Button key="cancel" label="cancel" onPress={() => void update($, editing, () => null)} />
        </Box>
      </Box>
    )

    const row = (entry: env.Entry) => {
      const k = entry.key
      if (edit && edit.file === file && edit.key === k) return valueEditor(k)
      const isShown = shown === `${file}:${k}`
      return (
        <Box key={`row:${k}`} gap={1}>
          <Box width={keyWidth} flexShrink={0}>
            <Text bold wrap="truncate">{k}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor={!isShown} wrap="truncate">{isShown ? entry.value || '(empty)' : env.shape(entry.value, true)}</Text>
          </Box>
          <Button
            key={`copy:${k}`}
            label="copy"
            plain
            onPress={async press => {
              const { isCopied } = await $.ui.copy({ text: entry.value, surface: press.surface })
              await say(isCopied ? `Copied ${k}` : `Could not copy ${k}`)
            }}
          />
          <Button key={`edit:${k}`} label="edit" plain onPress={() => void update($, editing, () => ({ file, key: k }))} />
          <Button
            key={`show:${k}`}
            label={isShown ? 'hide' : 'show'}
            plain
            onPress={() => void update($, revealed, now => (now === `${file}:${k}` ? null : `${file}:${k}`))}
          />
          {pending === `${file}:${k}` ? (
            <Button
              key={`really:${k}`}
              label="really delete?"
              variant="primary"
              onPress={async () => {
                await save($, file, env.remove(await load($, file), k))
                await update($, confirm, () => null)
                await say(`Deleted ${k} from ${file}`)
              }}
            />
          ) : (
            <Button key={`del:${k}`} label="del" plain dimColor onPress={() => void update($, confirm, () => `${file}:${k}`)} />
          )}
        </Box>
      )
    }

    const isNewKey = edit !== null && edit.file === file && edit.key !== null && !list.some(entry => entry.key === edit.key)

    return (
      <Box flexDirection="column">
        {card}

        <Box gap={1} flexWrap="wrap" marginBottom={1}>
          {names.map(name => (
            <Button
              key={`file:${name}`}
              label={name}
              variant={name === file ? 'primary' : undefined}
              dimColor={name !== file}
              onPress={() => void update($, active, () => name)}
            />
          ))}
          {!names.includes('.env.local') && (
            <Button key="create" label="+ .env.local" plain dimColor onPress={() => void save($, '.env.local', [])} />
          )}
        </Box>

        {isUnignored && <Text color="red">{file} is not in .gitignore</Text>}
        {note && <Text dimColor>{note}</Text>}
        {names.length === 0 && <Text dimColor>No .env files in the project root yet.</Text>}

        {list.map(row)}
        {isNewKey && edit?.key && valueEditor(edit.key)}

        {edit && edit.file === file && edit.key === null ? (
          <Input
            key="name"
            label="New key: "
            placeholder="NAME, Enter to continue"
            autoFocus
            onSubmit={name => {
              const key = name.trim()
              if (KEY_NAME.test(key)) void update($, editing, () => ({ file, key }))
              else void say(`"${key}" is not a valid key name`)
            }}
          />
        ) : (
          file !== '' && <Button key="add" label="+ add key" plain onPress={() => void update($, editing, () => ({ file, key: null }))} />
        )}

        {missing.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Missing compared with {template}:</Text>
            <Box gap={1} flexWrap="wrap">
              {missing.map(key => (
                <Button key={`fill:${key}`} label={key} plain dimColor onPress={() => void update($, editing, () => ({ file, key }))} />
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
