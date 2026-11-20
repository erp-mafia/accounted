/**
 * Proof that the type-check ratchet only compares complete tsc runs. On
 * 2026-10-11 tsc was killed under memory pressure, its empty output parsed as
 * "0 errors", and check:types passed: these cases now fail with exit code 2.
 */
import { describe, it, expect } from 'vitest'
import { describeCost, judgeTscRun, memoryLimit } from '../no-new-type-errors.mjs'

const FILE_ERROR = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"

describe('judgeTscRun', () => {
  it('accepts a clean run', () => {
    expect(judgeTscRun({ status: 0, signal: null, stdout: '', stderr: '' })).toEqual({ ok: true, output: '' })
  })

  it('accepts a run that found type errors', () => {
    expect(judgeTscRun({ status: 1, signal: null, stdout: FILE_ERROR, stderr: '' })).toEqual({
      ok: true,
      output: FILE_ERROR,
    })
    expect(judgeTscRun({ status: 2, signal: null, stdout: FILE_ERROR, stderr: '' }).ok).toBe(true)
  })

  it('rejects a run killed by a signal, even with partial output', () => {
    const result = judgeTscRun({ status: null, signal: 'SIGKILL', stdout: FILE_ERROR, stderr: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('SIGKILL')
  })

  it('rejects an out-of-memory crash, which exits with the same status as a run with errors', () => {
    const result = judgeTscRun({
      status: 2,
      signal: null,
      stdout: FILE_ERROR,
      stderr: 'fatal error: runtime: out of memory\n\ngoroutine 1 [running]:\n',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('out of memory')
  })

  it('rejects a compiler crash after some file errors were printed', () => {
    const result = judgeTscRun({
      status: 2,
      signal: null,
      stdout: FILE_ERROR,
      stderr: 'panic: runtime error: index out of range [3] with length 3\n\ngoroutine 41 [running]:\n',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('index out of range')
  })

  it('does not take the word panic inside an error message for a crash', () => {
    const output = "src/a.ts(1,7): error TS2304: Cannot find name 'panic'.\n"
    expect(judgeTscRun({ status: 1, signal: null, stdout: output, stderr: '' }).ok).toBe(true)
  })

  it('rejects an exit status tsc never uses for a result', () => {
    const result = judgeTscRun({ status: 137, signal: null, stdout: '', stderr: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('status 137')
  })

  it('rejects a failing run that reports no file errors (config or missing-file errors)', () => {
    const result = judgeTscRun({
      status: 2,
      signal: null,
      stdout: "error TS6053: File 'missing.ts' not found.\n",
      stderr: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('TS6053')
  })

  it('rejects a run that could not start', () => {
    const result = judgeTscRun({ status: null, signal: null, error: new Error('spawn ENOMEM') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('ENOMEM')
  })
})

describe('memoryLimit', () => {
  it('is three quarters of the machine, in MiB', () => {
    expect(memoryLimit(16 * 1024 ** 3)).toBe('12288MiB')
    expect(memoryLimit(24 * 1024 ** 3)).toBe('18432MiB')
  })

  it('never goes under 1 GiB', () => {
    expect(memoryLimit(512 * 1024 ** 2)).toBe('1024MiB')
  })
})

describe('describeCost', () => {
  it('reads the time and the memory from the diagnostics lines', () => {
    const output = `${FILE_ERROR}Types:                 28565\nMemory used:       10066330K\nCheck time:           61.2s\nTotal time:           71.25s\n`
    expect(describeCost(output)).toBe('71.3 s, 9.6 GB')
  })

  it('is empty when the lines are missing', () => {
    expect(describeCost(FILE_ERROR)).toBe('')
  })
})
