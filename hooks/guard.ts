import { isEnvFile, isTemplate } from './dotenv'

// Best effort: the scrubber in register.tsx is what actually keeps values out
// of the conversation. This only stops the obvious ways of reading them.

const ENV_TOKEN = /(?:^|[\s'"=/<>|;&(])(\.env(?:\.[\w.-]+)?)(?=$|[\s'";|&)<>])/g
const HARMLESS = /^\s*(ls|stat|test|\[|git\s+(status|check-ignore|ls-files))\b/
const DUMPS_ENV = /(?:^|[;&|(]\s*|\$\(\s*)(printenv\b|env\s*(?:$|[|;&>)])|export\s+-p\b|set\s*(?:$|[|;&>]))/
// A shell or interpreter runs its quoted arguments as code, so those stay checked
const RUNS_CODE = /(?:^|[\s;&|(])(?:sh|bash|zsh|fish|dash|eval|node|deno|bun|python[\d.]*|ruby|perl|php|osascript)\b/
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function isProtectedPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const name = basename(path)
  return isEnvFile(name) && !isTemplate(name)
}

// Text that only mentions a file name: heredoc bodies, commit messages, lines
// appended to .gitignore, and quoted sentences (a PR body, a prompt handed to
// another agent). Without this, writing a README that says ".env" or running
// `echo .env >> .gitignore` would be refused. A quoted argument counts as a
// sentence when it has a space and no command substitution in it.
function withoutProse(command: string): string {
  const code = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<heredoc')
    .replace(/(\bgit\s+commit\b[^;&|\n]*?\s-m\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1msg')
    .replace(/\b(echo|printf)\b[^;&|\n]*>>?\s*\S*\.gitignore\b/g, 'gitignore-edit')
  if (RUNS_CODE.test(code)) return code
  return code.replace(QUOTED, quoted => (/\s/.test(quoted) && !/\$\(|`/.test(quoted) ? '"prose"' : quoted))
}

export function bashReason(command: string): string | undefined {
  const code = withoutProse(command)
  if (DUMPS_ENV.test(code)) return 'it prints the environment'
  // Each command in a chain on its own, so `cd app && git check-ignore .env`
  // passes while `ls && cat .env` doesn't
  for (const segment of code.split(/&&|\|\||[;|\n]/)) {
    if (HARMLESS.test(segment)) continue
    for (const match of segment.matchAll(ENV_TOKEN)) {
      const name = match[1] ?? ''
      if (!isTemplate(name)) return `it touches ${name}`
    }
  }
  return undefined
}

export function grepReason(input: Record<string, unknown>): string | undefined {
  if (isProtectedPath(input.path)) return `it searches ${input.path}`
  if (typeof input.glob === 'string' && /(^|[/{,])\.env/.test(input.glob)) return 'its glob includes .env files'
  return undefined
}
