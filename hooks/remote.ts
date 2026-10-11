// Env files on another machine, named the way scp names them (box:~/app/.env).
// env only ever runs two fixed commands there over ssh: one prints the file,
// one replaces it with what env sends on stdin. The path is quoted, so it
// can't smuggle in a command of its own.

import { isEnvFile } from './dotenv'

export type Remote = { host: string; path: string }

// [user@]host, never starting with `-`, so ssh can't read it as an option
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/

// Exit status of the read command when the file isn't there
export const MISSING = 3

// undefined when the value isn't host:path at all, so it's a local file
export function parse(value: unknown): Remote | { error: string } | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  const colon = raw.indexOf(':')
  if (colon <= 0) return undefined
  const host = raw.slice(0, colon)
  const path = raw.slice(colon + 1)
  if (host.includes('/') || !HOST.test(host)) return undefined
  if (/[\n\r\0]/.test(path) || !isEnvFile(path.slice(path.lastIndexOf('/') + 1))) {
    return { error: `"${path}" on ${host} is not an env file.` }
  }
  return { host, path }
}

// Single quotes, keeping a leading ~/ outside them so the remote shell expands it
export function quote(path: string): string {
  const home = path.startsWith('~/') ? '~/' : ''
  return `${home}'${path.slice(home.length).replaceAll("'", `'\\''`)}'`
}

const ssh = (host: string, command: string) => ['ssh', '-o', 'BatchMode=yes', host, command]

export function reader({ host, path }: Remote): string[] {
  const file = quote(path)
  return ssh(host, `if [ -e ${file} ]; then cat -- ${file}; else exit ${MISSING}; fi`)
}

// A file env creates is readable by its owner only
export function writer({ host, path }: Remote): string[] {
  return ssh(host, `umask 077 && cat > ${quote(path)}`)
}
