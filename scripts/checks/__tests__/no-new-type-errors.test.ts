/**
 * Proof that the type-check ratchet only compares complete tsc runs. On
 * 2026-10-11 tsc was killed under memory pressure, its empty output parsed as
 * "0 errors", and check:types passed: these cases now fail with exit code 2.
 */
import { describe, it, expect } from 'vitest'
import { judgeTscRun } from '../no-new-type-errors.mjs'

const FILE_ERROR = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"

describe('judgeTscRun', () => {
  it('accepts a clean run', () => {
    expect(judgeTscRun({ status: 0, signal: null, stdout: '', stderr: '' })).toEqual({ ok: true, output: '' })
  })

  it('accepts a run that found type errors', () => {
    expect(judgeTscRun({ status: 2, signal: null, stdout: FILE_ERROR, stderr: '' })).toEqual({
      ok: true,
      output: FILE_ERROR,
    })
  })

  it('rejects a run killed by a signal, even with partial output', () => {
    const result = judgeTscRun({ status: null, signal: 'SIGKILL', stdout: FILE_ERROR, stderr: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('SIGKILL')
  })

  it('rejects an out-of-memory crash', () => {
    const result = judgeTscRun({
      status: 134,
      signal: null,
      stdout: '',
      stderr: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('out of memory')
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
