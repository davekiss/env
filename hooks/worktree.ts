// Env files in this repo's other git worktrees, so mcp__env__copy can seed a
// new worktree's .env.local from the main checkout. Only the root of a
// worktree `git worktree list` names counts: anywhere else, a copied value
// could land where the fence doesn't look.

import { isEnvFile } from './dotenv'

export function parseWorktrees(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
}

// Resolves `.` and `..` without touching the disk
export function normalize(path: string, base: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export type Place = { path: string; label: string }

// A bare name is a file in the session's own project root, as before. A path
// must end in an env file name and sit at the root of a known worktree.
export function resolve(value: unknown, cwd: string, worktrees: string[]): Place | { error: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: 'from and to must name env files.' }
  const raw = value.trim()
  if (!raw.includes('/')) {
    return isEnvFile(raw) ? { path: raw, label: raw } : { error: `"${raw}" is not an env file name.` }
  }
  const full = normalize(raw, cwd)
  const name = full.slice(full.lastIndexOf('/') + 1)
  const dir = full.slice(0, full.lastIndexOf('/')) || '/'
  if (!isEnvFile(name)) return { error: `"${raw}" is not an env file.` }
  if (!worktrees.includes(dir)) {
    const known = worktrees.length > 0 ? ` Worktrees: ${worktrees.join(', ')}` : ''
    return { error: `${dir} is not the root of one of this repo's git worktrees, so env won't write there.${known}` }
  }
  return { path: full, label: dir === cwd ? name : full }
}
