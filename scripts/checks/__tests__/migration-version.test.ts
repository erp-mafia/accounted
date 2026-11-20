/**
 * Proof that the migration-version guard flags two files with one version and
 * nothing else. Fixtures live in an OS temp directory the test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findDuplicateMigrationVersions } from '../migration-version.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-version-'))
  tempDirs.push(root)
  fs.mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true })
  for (const file of files) fs.writeFileSync(path.join(root, 'supabase', 'migrations', file), '')
  return root
}

describe('migration-version guard', () => {
  it('flags two files with one version', () => {
    const root = fixture(['20261101120100_a.sql', '20261101120100_b.sql', '20261101120200_c.sql'])
    expect(findDuplicateMigrationVersions(root)).toEqual([
      { version: '20261101120100', files: ['20261101120100_a.sql', '20261101120100_b.sql'] },
    ])
  })

  it('passes distinct versions and ignores other files', () => {
    const root = fixture(['20261101120100_a.sql', '20261101120200_a.sql', 'README.md'])
    expect(findDuplicateMigrationVersions(root)).toEqual([])
  })

  it('holds for the repository', () => {
    expect(findDuplicateMigrationVersions(process.cwd())).toEqual([])
  })
})
