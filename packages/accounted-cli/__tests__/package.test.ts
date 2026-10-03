import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLIENT_NAME, VERSION } from '../lib/version.mjs'

const packageDir = path.resolve(__dirname, '..')
const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
  name: string
  version: string
  bin: Record<string, string>
  files: string[]
  engines: { node: string }
  dependencies?: Record<string, string>
  repository: { url: string; directory: string }
}

describe('accounted package', () => {
  it('publishes the accounted command with no runtime dependencies', () => {
    expect(packageJson.name).toBe('accounted')
    expect(packageJson.bin).toEqual({ accounted: './bin/accounted.mjs' })
    expect(packageJson.dependencies).toBeUndefined()
    expect(packageJson.files).toEqual(['bin', 'lib', 'README.md'])
    expect(packageJson.engines.node).toBe('>=20')
  })

  it('points provenance at this repository and directory', () => {
    // npm rejects the provenance attestation unless repository.url matches
    // the repository the publishing workflow runs in.
    expect(packageJson.repository.url).toBe('git+https://github.com/erp-mafia/accounted.git')
    expect(packageJson.repository.directory).toBe('packages/accounted-cli')
  })

  it('keeps the version constant in step with package.json', () => {
    expect(VERSION).toBe(packageJson.version)
    expect(CLIENT_NAME).toBe(`accounted-cli-${packageJson.version}`)
  })

  it('sends a client name the server accepts for telemetry', () => {
    // Same pattern as the X-Accounted-Client check in the MCP server; a name
    // failing it is dropped silently and the CLI would vanish from the stats.
    expect(CLIENT_NAME).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
  })

  it('runs as a command', () => {
    const bin = path.join(packageDir, 'bin', 'accounted.mjs')
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()).toBe(VERSION)
  })

  it('never talks to REST v1, where writes commit without approval', () => {
    const offenders = sourceFiles(path.join(packageDir, 'lib')).filter((file) =>
      readFileSync(file, 'utf8').includes('/api/v1')
    )
    expect(offenders).toEqual([])
  })
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  )
}
