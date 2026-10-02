import { isEnvFile, isTemplate } from './dotenv'

// Best effort: the scrubber in register.tsx is what actually keeps values out
// of the conversation. This only stops the obvious ways of reading them.

const ENV_TOKEN = /(?:^|[\s'"=/<>|;&(])(\.env(?:\.[\w.-]+)?)(?=$|[\s'";|&)<>])/g
const HARMLESS = /^\s*(ls|stat|test|\[|git\s+(status|check-ignore|ls-files))\b/
const DUMPS_ENV = /(?:^|[;&|(]\s*|\$\(\s*)(printenv\b|env\s*(?:$|[|;&>)])|export\s+-p\b|set\s*(?:$|[|;&>]))/

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function isProtectedPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const name = basename(path)
  return isEnvFile(name) && !isTemplate(name)
}

// Text that only mentions a file name: heredoc bodies, commit messages, and
// lines appended to .gitignore. Without this, writing a README that says
// ".env" or running `echo .env >> .gitignore` would be refused.
function withoutProse(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<heredoc')
    .replace(/(\bgit\s+commit\b[^;&|\n]*?\s-m\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1msg')
    .replace(/\b(echo|printf)\b[^;&|\n]*>>?\s*\S*\.gitignore\b/g, 'gitignore-edit')
}

export function bashReason(command: string): string | undefined {
  const code = withoutProse(command)
  if (DUMPS_ENV.test(code)) return 'it prints the environment'
  if (HARMLESS.test(code)) return undefined
  for (const match of code.matchAll(ENV_TOKEN)) {
    const name = match[1] ?? ''
    if (!isTemplate(name)) return `it touches ${name}`
  }
  return undefined
}

export function grepReason(input: Record<string, unknown>): string | undefined {
  if (isProtectedPath(input.path)) return `it searches ${input.path}`
  if (typeof input.glob === 'string' && /(^|[/{,])\.env/.test(input.glob)) return 'its glob includes .env files'
  return undefined
}
