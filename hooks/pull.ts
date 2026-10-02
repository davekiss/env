// mcp__env__pull runs a hosting or secrets CLI (vercel, doppler, op...) and
// writes what it prints into an env file, so values come down from the
// service without passing through the conversation. The reverse of push.

import * as env from './dotenv'
import { CLIS, keysIn } from './push'

// Stands for a fresh temp file, for CLIs that write a file rather than print
// (`vercel env pull {{@file}}`). The @ keeps it from naming a real key.
export const OUT = '{{@file}}'

export type Plan = { argv: string[]; key?: string; keys?: string[]; usesFile: boolean }

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

export function check(argv: unknown, key: unknown, keys: unknown): Plan | { error: string } {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 || !argv.every(arg => typeof arg === 'string')) {
    return { error: 'argv must be a non-empty list of strings, the CLI first.' }
  }
  const cli = argv[0] as string
  if (!CLIS.includes(cli)) {
    return { error: `env only runs hosting CLIs, by bare name: ${CLIS.join(', ')}. "${cli}" is not one of them.` }
  }
  if (keysIn(argv.slice(1)).length > 0) {
    return { error: 'pull does not fill in {{KEY}} placeholders; only push sends values out.' }
  }
  if (key !== undefined && (typeof key !== 'string' || !KEY_NAME.test(key))) return { error: `"${key}" is not a valid env key name.` }
  if (keys !== undefined && (!Array.isArray(keys) || !keys.every(k => typeof k === 'string' && KEY_NAME.test(k)))) {
    return { error: 'keys must be a list of env key names.' }
  }
  const usesFile = argv.includes(OUT)
  if (usesFile && key !== undefined) return { error: `Use either ${OUT} (a file of KEY=value lines) or key (one printed value), not both.` }
  return { argv: argv as string[], key, keys: keys as string[] | undefined, usesFile }
}

// What the CLI gave: one value it printed, or the KEY=value lines it printed
// or wrote. `op read` and friends end the value with a newline; drop just that.
export function incoming(plan: Plan, text: string): Record<string, string> {
  if (plan.key) {
    const value = text.replace(/\r?\n$/, '')
    return value === '' ? {} : { [plan.key]: value }
  }
  const values: Record<string, string> = {}
  for (const entry of env.entries(env.parse(text))) {
    if (!plan.keys || plan.keys.includes(entry.key)) values[entry.key] = entry.value
  }
  return values
}

export type Merge = { lines: env.Line[]; added: string[]; changed: string[]; same: string[]; kept: string[] }

// A key the file already has with another value is kept unless overwrite is
// set: the local value may be the one the user means to use
export function merge(lines: env.Line[], values: Record<string, string>, overwrite: boolean): Merge {
  const out: Merge = { lines, added: [], changed: [], same: [], kept: [] }
  for (const [key, value] of Object.entries(values)) {
    const now = env.get(out.lines, key)
    if (now === value) out.same.push(key)
    else if (now !== undefined && now !== '' && !overwrite) out.kept.push(key)
    else {
      ;(now === undefined || now === '' ? out.added : out.changed).push(key)
      out.lines = env.set(out.lines, key, value)
    }
  }
  return out
}

// Keys the file would lose its own value for, so the user is asked first
export function conflicts(lines: env.Line[], values: Record<string, string>): string[] {
  return Object.entries(values)
    .filter(([key, value]) => {
      const now = env.get(lines, key)
      return now !== undefined && now !== '' && now !== value
    })
    .map(([key]) => key)
}
