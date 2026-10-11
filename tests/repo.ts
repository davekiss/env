import type { TestBody } from 'claude-code/testing'

export const MAIN = '/repo/app'
export const FEATURE = '/repo/app-feature'

// A repo with a second worktree, files kept in memory by absolute path (a
// bare name is the main checkout's), and git answering for MAIN
export function repo(on: Parameters<TestBody>[1], files: Record<string, string>): Record<string, string> {
  // The engine resolves a bare name against the test's own folder
  const abs = (path: string) => (path.startsWith('/repo/') ? path : `${MAIN}/${path.split('/').pop()}`)
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
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    const stdout =
      args === 'rev-parse --show-toplevel'
        ? `${MAIN}\n`
        : args === 'rev-parse --show-prefix'
          ? '\n'
          : args === 'worktree list --porcelain'
            ? `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${FEATURE}\nHEAD def\nbranch refs/heads/feature\n`
            : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return files
}
