import type { TestBody } from 'claude-code/testing'

export const MAIN = '/repo/app'
export const FEATURE = '/repo/app-feature'
// A folder that is in no worktree
export const OUTSIDE = '/outside/app'

// Machines reachable over ssh: each host's one env file (undefined if it has
// none), the ssh exit status to fake a failure, every ssh command run, and the
// questions put to the user, who answers each with `answer`
export type Far = {
  hosts: Record<string, string | undefined>
  status?: number
  ran: { argv: string[]; stdin?: string }[]
  asked: string[]
  answer: string
}

export function far(hosts: Far['hosts'] = {}, answer = 'Allow'): Far {
  return { hosts, ran: [], asked: [], answer }
}

// A repo with a second worktree, files kept in memory by absolute path (a
// bare name is the main checkout's), and git answering for MAIN
export function repo(on: Parameters<TestBody>[1], files: Record<string, string>, world: Far = far()): Record<string, string> {
  // The engine resolves a bare name against the test's own folder
  const abs = (path: string) => (/^\/(repo|outside)\//.test(path) ? path : `${MAIN}/${path.split('/').pop()}`)
  on('fs.list', () => ({ value: [{ name: '.env.local', kind: 'file', size: 1, mtimeMs: 1 }] }) as never)
  on('fs.read', ($, e) => {
    const text = files[abs(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files[abs(e.path)] !== undefined }))
  on('fs.write', ($, e) => {
    files[abs(e.path)] = e.text
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    world.asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: world.answer } } } as never
  })
  on('process.run', ($, e) => {
    const ran = (exitCode: number, stdout = '', stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'ssh') {
      const argv = [...e.argv]
      const host = argv[3] ?? ''
      world.ran.push({ argv, stdin: e.init?.stdin })
      if (world.status !== undefined) return ran(world.status, '', `ssh: connect to host ${host}: Connection refused`)
      if ((argv[4] ?? '').startsWith('umask')) {
        world.hosts[host] = e.init?.stdin ?? ''
        return ran(0)
      }
      const text = world.hosts[host]
      return text === undefined ? ran(3) : ran(0, text)
    }
    const args = e.argv.slice(1).join(' ')
    const stdout =
      args === 'rev-parse --show-toplevel'
        ? `${MAIN}\n`
        : args === 'rev-parse --show-prefix'
          ? '\n'
          : args === 'worktree list --porcelain'
            ? `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${FEATURE}\nHEAD def\nbranch refs/heads/feature\n`
            : ''
    return ran(0, stdout)
  })
  return files
}
