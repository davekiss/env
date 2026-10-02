// A .env parser that keeps the file as written: comments, blank lines, order
// and quoting survive a round trip, and only the entries we change are redrawn.

export type Raw = { kind: 'raw'; raw: string }
export type Entry = { kind: 'entry'; key: string; value: string; prefix: string; raw: string }
export type Line = Raw | Entry

const ASSIGN = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/
const BARE = /^[A-Za-z0-9_\-.,:/@+=%~]*$/

export function parse(text: string): Line[] {
  const rows = text.split(/\r?\n/)
  const lines: Line[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? ''
    const match = ASSIGN.exec(row)
    if (!match) {
      lines.push({ kind: 'raw', raw: row })
      continue
    }

    const [, exported = '', key = '', rest = ''] = match
    const quote = rest.trimStart()[0]
    let value: string
    let raw = row

    if (quote === '"' || quote === "'" || quote === '`') {
      // A quoted value may run over several lines until its closing quote
      let body = rest.trimStart().slice(1)
      let end = closing(body, quote)
      let j = i
      while (end < 0 && j + 1 < rows.length) {
        j += 1
        body += '\n' + (rows[j] ?? '')
        end = closing(body, quote)
      }
      if (end < 0) {
        // Never closed: keep the line as it stands rather than swallow the file
        lines.push({ kind: 'raw', raw: row })
        continue
      }
      raw = rows.slice(i, j + 1).join('\n')
      i = j
      value = body.slice(0, end)
      if (quote === '"') {
        value = value.replace(/\\([nr"\\])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c))
      }
    } else {
      value = rest.replace(/\s+#.*$/, '').trim()
    }

    lines.push({ kind: 'entry', key, value, prefix: exported, raw })
  }

  return lines
}

function closing(body: string, quote: string): number {
  for (let k = 0; k < body.length; k++) {
    if (quote === '"' && body[k] === '\\') {
      k += 1
    } else if (body[k] === quote) {
      return k
    }
  }
  return -1
}

export function quote(value: string): string {
  if (BARE.test(value)) return value
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

export function serialize(lines: Line[]): string {
  return lines.map(line => line.raw).join('\n')
}

export function entries(lines: Line[]): Entry[] {
  // dotenv takes the last of a repeated key, so the list does too
  const byKey = new Map<string, Entry>()
  for (const line of lines) {
    if (line.kind === 'entry') {
      byKey.delete(line.key)
      byKey.set(line.key, line)
    }
  }
  return [...byKey.values()]
}

export function get(lines: Line[], key: string): string | undefined {
  return entries(lines).find(entry => entry.key === key)?.value
}

export function set(lines: Line[], key: string, value: string): Line[] {
  const at = lines.findLastIndex(line => line.kind === 'entry' && line.key === key)
  if (at >= 0) {
    const old = lines[at] as Entry
    const next: Entry = { ...old, value, raw: `${old.prefix}${key}=${quote(value)}` }
    return lines.map((line, i) => (i === at ? next : line))
  }

  const added: Entry = { kind: 'entry', key, value, prefix: '', raw: `${key}=${quote(value)}` }
  const last = lines[lines.length - 1]
  // Keep the file's trailing newline after the new line
  if (last?.kind === 'raw' && last.raw === '') {
    return [...lines.slice(0, -1), added, last]
  }
  return [...lines, added, { kind: 'raw', raw: '' }]
}

export function remove(lines: Line[], key: string): Line[] {
  return lines.filter(line => !(line.kind === 'entry' && line.key === key))
}

export function commentOut(lines: Line[], key: string, note: string): Line[] {
  return lines.map(line =>
    line.kind === 'entry' && line.key === key
      ? { kind: 'raw', raw: `# ${note}\n` + line.raw.split('\n').map(row => `# ${row}`).join('\n') }
      : line,
  )
}

export function isEnvFile(name: string): boolean {
  return /^\.env(\.[\w.-]+)?$/.test(name)
}

export function isTemplate(name: string): boolean {
  return /^\.env\.(example|sample|template|defaults|dist)$/.test(name)
}

// What a value looks like, without saying what it is. `showTail` adds the
// last four characters, for the person's screen only.
export function shape(value: string, showTail = false): string {
  if (value === '') return '(empty)'
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)
  const prefix =
    scheme?.[0] ??
    /^(sk|pk|rk|whsec|ghp|gho|ghs|github_pat|xox[abpr]|sk-ant|sk-proj|re|AKIA)[_-]((live|test)[_-])?/i.exec(value)?.[0] ??
    (value.startsWith('eyJ') ? 'eyJ' : '')
  const tail = showTail && value.length > 12 ? value.slice(-4) : ''
  return `${prefix}${'•'.repeat(prefix || tail ? 4 : 8)}${tail}`
}

export function kind(value: string): string {
  if (value === '') return 'empty'
  if (/^(true|false)$/i.test(value)) return 'boolean'
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return `url (${value.split(':')[0]})`
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(value)) return 'jwt'
  if (/^[0-9a-f]+$/i.test(value)) return 'hex'
  return 'string'
}

export function isSecretish(value: string): boolean {
  return value.length >= 8 && !/^(true|false|-?\d+(\.\d+)?)$/i.test(value)
}

// Longest first, so a value inside another is never cut out of it
export type Index = ReadonlyArray<readonly [value: string, key: string]>

export function buildIndex(files: Record<string, Line[]>): Index {
  const seen = new Map<string, string>()
  for (const [file, lines] of Object.entries(files)) {
    if (isTemplate(file)) continue
    for (const entry of entries(lines)) {
      if (isSecretish(entry.value)) seen.set(entry.value, entry.key)
    }
  }
  return [...seen].sort((a, b) => b[0].length - a[0].length)
}

export function scrub(text: string, index: Index): string {
  let out = text
  for (const [value, key] of index) {
    if (out.includes(value)) out = out.split(value).join(`[env:${key}]`)
  }
  return out
}

export function randomSecret(bytes: number, format: 'base64url' | 'hex'): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  if (format === 'hex') return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
