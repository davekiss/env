import { describe, expect, test } from 'claude-code/testing'

import * as env from '../hooks/dotenv'
import { bashReason } from '../hooks/guard'

const FILE = [
  '# Stripe',
  'export STRIPE_KEY=sk_live_abc123def456',
  '',
  "NAME='Dave K'  ",
  'CERT="line one',
  'line two"',
  'URL=https://x.test # trailing note',
  'DUP=first',
  'DUP=second',
  '',
].join('\n')

describe('parse and serialize', () => {
  test('an untouched file comes back byte for byte', async () => {
    expect(env.serialize(env.parse(FILE))).toBe(FILE)
  })

  test('reads quoted, multiline, commented and repeated values as dotenv does', async () => {
    const lines = env.parse(FILE)
    expect(env.get(lines, 'STRIPE_KEY')).toBe('sk_live_abc123def456')
    expect(env.get(lines, 'NAME')).toBe('Dave K')
    expect(env.get(lines, 'CERT')).toBe('line one\nline two')
    expect(env.get(lines, 'URL')).toBe('https://x.test')
    expect(env.get(lines, 'DUP')).toBe('second')
  })

  test('setting one key rewrites only its line and keeps export', async () => {
    const out = env.serialize(env.set(env.parse(FILE), 'STRIPE_KEY', 'sk_live_new'))
    expect(out).toBe(FILE.replace('sk_live_abc123def456', 'sk_live_new'))
  })

  test('a new key goes before the trailing newline', async () => {
    expect(env.serialize(env.set(env.parse('A=1\n'), 'B', '2'))).toBe('A=1\nB=2\n')
    expect(env.serialize(env.set(env.parse('A=1'), 'B', '2'))).toBe('A=1\nB=2\n')
  })

  test('awkward values survive a write and a read', async () => {
    for (const value of ['a b', "it's", 'x"y', 'multi\nline', 'p@ss#word', '$HOME', '']) {
      const text = env.serialize(env.set(env.parse(''), 'K', value))
      expect(env.get(env.parse(text), 'K')).toBe(value)
    }
  })

  test('commenting out keeps the value recoverable and drops the key', async () => {
    const lines = env.commentOut(env.parse(FILE), 'CERT', 'removed')
    expect(env.get(lines, 'CERT')).toBeUndefined()
    expect(env.serialize(lines)).toContain('# CERT="line one\n# line two"')
  })
})

describe('scrub', () => {
  const index = env.buildIndex({
    '.env': env.parse('LONG=abcdefgh12345\nSHORT=abcdefgh\nFLAG=true\nPORT=30000000'),
    '.env.example': env.parse('EXAMPLE=placeholder-value'),
  })

  test('replaces secret values with their key, longest first', async () => {
    expect(env.scrub('x abcdefgh12345 y abcdefgh z', index)).toBe('x [env:LONG] y [env:SHORT] z')
  })

  test('leaves booleans, numbers and template values alone', async () => {
    expect(env.scrub('true 30000000 placeholder-value', index)).toBe('true 30000000 placeholder-value')
  })
})

describe('bash fence', () => {
  test('blocks reading env files and dumping the environment', async () => {
    for (const command of ['cat .env', 'source .env.local', "node -e \"fs.readFileSync('.env')\"", 'printenv', 'ls && env | sort']) {
      expect(bashReason(command)).toBeDefined()
    }
  })

  test('allows templates, listings and unrelated commands', async () => {
    for (const command of ['cat .env.example', 'ls -la .env*', 'npm run dev', 'env FOO=1 node x.js', 'git status']) {
      expect(bashReason(command)).toBeUndefined()
    }
  })

  test('allows text that only mentions env files', async () => {
    for (const command of [
      'echo .env.local >> .gitignore',
      'git commit -m "stop tracking .env"',
      "cat > README.md <<'EOF'\nPut keys in .env.local, never run printenv\nEOF",
    ]) {
      expect(bashReason(command)).toBeUndefined()
    }
  })

  test('still blocks a read next to that text', async () => {
    for (const command of ['git commit -m "x" && cat .env', "cat .env <<'EOF'\nx\nEOF"]) {
      expect(bashReason(command)).toBeDefined()
    }
  })

  test('allows quoted sentences that mention env files, and harmless commands later in a chain', async () => {
    for (const command of [
      'herdr agent prompt env-test "Set the key in .env.local, then report back"',
      'gh pr create --title "Fence fix" --body "Commands that mention .env.local in prose now pass"',
      'cd ~/app && git check-ignore -v .env.local',
      'cd ~/app && ls -a .env.local',
    ]) {
      expect(bashReason(command)).toBeUndefined()
    }
  })

  test('still blocks code in quotes, substitutions in sentences, and reads after a harmless command', async () => {
    for (const command of [
      'bash -c "cat .env.local | head"',
      'python3 -c "import os; print(open(\'.env\').read())"',
      'echo "here it is: $(cat .env.local)"',
      'cat ".env.local"',
      'ls .env && cat .env',
      'cd ~/app && cat .env.local',
    ]) {
      expect(bashReason(command)).toBeDefined()
    }
  })
})
