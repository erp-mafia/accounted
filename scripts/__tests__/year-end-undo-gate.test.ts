import { describe, it, expect } from 'vitest'
import {
  evaluateYearEndUndoGate,
  type GateSignatureRequest,
  type GateVersion,
  type YearEndUndoGateInput,
} from '../lib/year-end-undo-gate'

const V2: GateVersion = { id: 'v2', version_number: 2, status: 'ready_for_signature' }

function request(overrides: Partial<GateSignatureRequest> = {}): GateSignatureRequest {
  return {
    id: overrides.id ?? 'r1',
    status: 'pending',
    signed_at: null,
    annual_report_version_id: 'v2',
    ...overrides,
  }
}

function input(overrides: Partial<YearEndUndoGateInput> = {}): YearEndUndoGateInput {
  return {
    submissions: [],
    signatureRequests: [],
    versions: [],
    agmDate: null,
    today: '2026-09-25',
    ...overrides,
  }
}

describe('evaluateYearEndUndoGate', () => {
  it('passes a period with no annual report state at all', () => {
    const result = evaluateYearEndUndoGate(input())
    expect(result.blockers).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.versionsToSupersede).toEqual([])
    expect(result.voidedRequests).toEqual([])
  })

  it('does not block on pending requests; supersedes their ready_for_signature version', () => {
    const result = evaluateYearEndUndoGate(
      input({
        versions: [{ id: 'v1', version_number: 1, status: 'superseded' }, V2],
        signatureRequests: [request({ id: 'r1' }), request({ id: 'r2' })],
      })
    )
    expect(result.blockers).toEqual([])
    expect(result.versionsToSupersede).toEqual([V2])
    expect(result.voidedRequests.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(result.warnings.join(' ')).toMatch(/2 pending signature request\(s\)/)
  })

  it('blocks when any signer has signed, even if the version is not fully signed', () => {
    const result = evaluateYearEndUndoGate(
      input({
        versions: [V2],
        signatureRequests: [
          request({ id: 'r1', status: 'signed', signed_at: '2026-09-23T10:00:00Z' }),
          request({ id: 'r2' }),
        ],
      })
    )
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0]).toMatch(/already signed/)
  })

  it('treats a set signed_at as signed regardless of status', () => {
    const result = evaluateYearEndUndoGate(
      input({ signatureRequests: [request({ signed_at: '2026-09-23T10:00:00Z' })] })
    )
    expect(result.blockers[0]).toMatch(/already signed/)
  })

  it.each(['signed', 'filed', 'registered'])('blocks on a %s version', (status) => {
    const result = evaluateYearEndUndoGate(
      input({ versions: [{ id: 'v3', version_number: 3, status }] })
    )
    expect(result.blockers).toEqual([`årsredovisning version 3 is ${status}: refuse to reopen`])
  })

  it('blocks on any submission row, whatever its status', () => {
    const result = evaluateYearEndUndoGate(
      input({ submissions: [{ id: 's1', status: 'draft' }] })
    )
    expect(result.blockers[0]).toMatch(/submission exists .*status: draft/)
  })

  it('does not block on draft or superseded versions and does not supersede them', () => {
    const result = evaluateYearEndUndoGate(
      input({
        versions: [
          { id: 'v1', version_number: 1, status: 'draft' },
          { id: 'v2', version_number: 2, status: 'superseded' },
        ],
      })
    )
    expect(result.blockers).toEqual([])
    expect(result.versionsToSupersede).toEqual([])
  })

  it('keeps unbound pending roster slots and declined requests, with a note', () => {
    const result = evaluateYearEndUndoGate(
      input({
        signatureRequests: [
          request({ id: 'roster', annual_report_version_id: null }),
          request({ id: 'no', status: 'declined' }),
        ],
      })
    )
    expect(result.blockers).toEqual([])
    expect(result.voidedRequests).toEqual([])
    expect(result.warnings.join(' ')).toMatch(/1 unbound pending signer slot/)
    expect(result.warnings.join(' ')).toMatch(/1 declined signature request/)
  })

  it('does not void pending requests bound to a version that is already superseded', () => {
    const result = evaluateYearEndUndoGate(
      input({
        versions: [{ id: 'v2', version_number: 2, status: 'superseded' }],
        signatureRequests: [request()],
      })
    )
    expect(result.voidedRequests).toEqual([])
  })

  it('warns, without blocking, when an AGM date on or before today is recorded', () => {
    const past = evaluateYearEndUndoGate(input({ agmDate: '2026-09-24' }))
    expect(past.blockers).toEqual([])
    expect(past.warnings.join(' ')).toMatch(/årsstämma date \(2026-09-24\)/)

    const future = evaluateYearEndUndoGate(input({ agmDate: '2026-10-30' }))
    expect(future.warnings).toEqual([])
  })
})
