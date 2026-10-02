// mcp__env__push runs a hosting provider's own CLI (vercel, gh, wrangler...)
// with values from an env file filled in for {{KEY}} placeholders, so a
// secret reaches the service without passing through the conversation.
// The CLIs already hold the user's login; env only fills in the blanks.

// Only these run, so a filled-in value can't be handed to curl or a script.
// Bare names, looked up on PATH like any shell would.
export const CLIS = [
  'aws',
  'az',
  'doppler',
  'firebase',
  'fly',
  'flyctl',
  'gcloud',
  'gh',
  'heroku',
  'netlify',
  'railway',
  'render',
  'supabase',
  'vercel',
  'wrangler',
]

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g

export type Plan = { argv: string[]; stdin?: string; keys: string[] }

export function keysIn(texts: string[]): string[] {
  const keys = new Set<string>()
  for (const text of texts) for (const match of text.matchAll(PLACEHOLDER)) keys.add(match[1] ?? '')
  return [...keys]
}

export function check(argv: unknown, stdin: unknown): Plan | { error: string } {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 || !argv.every(arg => typeof arg === 'string')) {
    return { error: 'argv must be a non-empty list of strings, the CLI first.' }
  }
  if (stdin !== undefined && typeof stdin !== 'string') return { error: 'stdin must be a string.' }
  const cli = argv[0] as string
  if (!CLIS.includes(cli)) {
    return { error: `env only runs hosting CLIs, by bare name: ${CLIS.join(', ')}. "${cli}" is not one of them.` }
  }
  const keys = keysIn([...argv.slice(1), stdin ?? ''])
  if (keys.length === 0) {
    return { error: 'Nothing in argv or stdin names a {{KEY}}, so no env value is needed. Run the command with Bash instead.' }
  }
  return { argv: argv as string[], stdin, keys }
}

export function fill(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => values[key] ?? whole)
}

// Belt and braces over the scrubber, which skips values under 8 characters:
// whatever was filled in comes back out of the CLI's output by name
export function redact(text: string, values: Record<string, string>): string {
  const known = Object.entries(values)
    .filter(([, value]) => value.length >= 3)
    .sort(([, a], [, b]) => b.length - a.length)
  return known.reduce((out, [key, value]) => out.split(value).join(`[env:${key}]`), text)
}

// The command as the user is asked to approve it: placeholders, never values
export function shown(plan: Plan): string {
  const words = plan.argv.map(arg => (/^[\w@%+=:,./{}-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
  return words.join(' ') + (plan.stdin === undefined ? '' : ` < ${JSON.stringify(plan.stdin)}`)
}

export function tail(text: string, max = 1500): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}
