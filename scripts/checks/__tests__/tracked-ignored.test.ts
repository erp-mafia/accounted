/**
 * Proof that the tracked-ignored guard lists a tracked file that .gitignore
 * ignores and nothing else. Fixtures are git repositories in an OS temp
 * directory the test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findTrackedIgnoredFiles } from '../tracked-ignored.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'pipe' })
}

function repository(files: Record<string, string>, forced: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-ignored-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  git(root, 'add', '.')
  if (forced.length) git(root, 'add', '-f', ...forced)
  git(root, 'commit', '-q', '-m', 'fixture')
  return root
}

describe('tracked-ignored guard', () => {
  it('lists a file that was added past the rule', () => {
    const root = repository(
      { '.gitignore': '/notes/\n', 'src/a.ts': '', 'notes/2026/one.md': 'x', 'notes/two.md': 'x' },
      ['notes/2026/one.md', 'notes/two.md'],
    )
    expect(findTrackedIgnoredFiles(root)).toEqual(['notes/2026/one.md', 'notes/two.md'])
  })

  it('lists a file that was tracked before the rule was written', () => {
    const root = repository({ 'build/out.js': 'x', 'src/a.ts': '' })
    fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n')
    git(root, 'add', '.gitignore')
    git(root, 'commit', '-q', '-m', 'ignore build')
    expect(findTrackedIgnoredFiles(root)).toEqual(['build/out.js'])
  })

  it('reads a .gitignore in a subdirectory too', () => {
    const root = repository({ 'pkg/.gitignore': 'dist/\n', 'pkg/dist/x.js': 'x', 'pkg/index.ts': '' }, ['pkg/dist/x.js'])
    expect(findTrackedIgnoredFiles(root)).toEqual(['pkg/dist/x.js'])
  })

  it('passes a tree whose ignored files are untracked', () => {
    const root = repository({ '.gitignore': '/notes/\n', 'src/a.ts': '' })
    fs.mkdirSync(path.join(root, 'notes'))
    fs.writeFileSync(path.join(root, 'notes', 'local.md'), 'x')
    expect(findTrackedIgnoredFiles(root)).toEqual([])
  })

  it('answers with nothing outside a git checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-ignored-plain-'))
    tempDirs.push(root)
    expect(findTrackedIgnoredFiles(root)).toEqual([])
  })
})
