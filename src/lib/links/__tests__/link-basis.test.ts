import { describe, expect, it } from 'vitest'
import {
  LINK_BASES,
  MAX_LINK_EVIDENCE_BYTES,
  cleanEvidence,
  isLinkBasis,
  linkBasisForReconciliationMethod,
  readLinkBasis,
  resolveLinkBasis,
} from '../link-basis'
import { linkBasisColumns } from '../stamp'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'

const OP_ID = '6f1c2a5e-3b7d-4c1a-9e2f-0a1b2c3d4e5f'

describe('resolveLinkBasis', () => {
  it("keeps a person's pairing as named in a person's request", () => {
    expect(resolveLinkBasis('user_confirmed', undefined, { pendingOperationId: null, actorType: 'user' })).toEqual({
      link_basis: 'user_confirmed',
      link_evidence: null,
    })
    expect(resolveLinkBasis('user_created', undefined, { pendingOperationId: null })).toEqual({
      link_basis: 'user_created',
      link_evidence: null,
    })
  })

  it('records an approval of a staged pairing as agent_proposed_user_approved, naming the operation', () => {
    for (const door of ['user_confirmed', 'user_created'] as const) {
      expect(resolveLinkBasis(door, { score: 0.9 }, { pendingOperationId: OP_ID, actorType: 'api_key' })).toEqual({
        link_basis: 'agent_proposed_user_approved',
        link_evidence: { score: 0.9, pending_operation_id: OP_ID },
      })
    }
  })

  it('records a direct write by a machine credential as client_asserted: nobody approved it in Accounted', () => {
    for (const actorType of ['api_key', 'mcp_oauth', 'service_account', 'agent_chat']) {
      expect(resolveLinkBasis('user_confirmed', undefined, { pendingOperationId: null, actorType }).link_basis).toBe('client_asserted')
    }
  })

  it('records a person-shaped door on a cron or system run as system_derived', () => {
    expect(resolveLinkBasis('user_created', undefined, { pendingOperationId: null, actorType: 'cron' }).link_basis).toBe('system_derived')
    expect(resolveLinkBasis('user_created', undefined, { pendingOperationId: null, actorType: 'system' }).link_basis).toBe('system_derived')
  })

  it('keeps a rule a rule wherever it runs (the rule chose the pair), recording an approval as evidence', () => {
    expect(
      resolveLinkBasis('rule_ocr_reference', { rule_id: 'auto_reference', reference: '12345' }, { pendingOperationId: null, actorType: 'api_key' }),
    ).toEqual({ link_basis: 'rule_ocr_reference', link_evidence: { rule_id: 'auto_reference', reference: '12345' } })
    expect(resolveLinkBasis('rule_amount_date', undefined, { pendingOperationId: OP_ID, actorType: 'user' })).toEqual({
      link_basis: 'rule_amount_date',
      link_evidence: { pending_operation_id: OP_ID },
    })
  })

  it('keeps import_carried_over and system_derived as named', () => {
    expect(resolveLinkBasis('import_carried_over', undefined, { pendingOperationId: null, actorType: 'api_key' }).link_basis).toBe('import_carried_over')
    expect(resolveLinkBasis('system_derived', undefined, { pendingOperationId: OP_ID, actorType: 'user' })).toEqual({
      link_basis: 'system_derived',
      link_evidence: { pending_operation_id: OP_ID },
    })
  })
})

describe('linkBasisColumns reads the request scope', () => {
  it('outside any scope: the door basis', () => {
    expect(linkBasisColumns('user_confirmed')).toEqual({ link_basis: 'user_confirmed', link_evidence: null })
  })

  it('inside an approval, whoever relays it: agent_proposed_user_approved with the operation id', async () => {
    const stamped = await runWithActor({ type: 'mcp_oauth', label: 'Claude' }, () =>
      runInOperationCommit(OP_ID, async () => linkBasisColumns('user_confirmed')),
    )
    expect(stamped).toEqual({ link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OP_ID } })
  })

  it('on an API key outside an approval: client_asserted', async () => {
    const stamped = await runWithActor({ type: 'api_key', label: 'Integration' }, async () => linkBasisColumns('user_created'))
    expect(stamped.link_basis).toBe('client_asserted')
  })

  it("in a person's session: the door basis", async () => {
    const stamped = await runWithActor({ type: 'user' }, async () => linkBasisColumns('user_confirmed', { rule_id: 'auto_exact', score: 0.95 }))
    expect(stamped).toEqual({ link_basis: 'user_confirmed', link_evidence: { rule_id: 'auto_exact', score: 0.95 } })
  })
})

describe('evidence', () => {
  it('keeps only the documented fields, valid ones, and answers null when nothing is left', () => {
    expect(cleanEvidence({})).toBeNull()
    expect(cleanEvidence({ rule_id: 'auto_exact', bogus: 'x', score: 7, receipt_id: 'not-a-uuid' })).toEqual({ rule_id: 'auto_exact' })
    expect(cleanEvidence({ score: 0.5, reference: '' })).toEqual({ score: 0.5 })
    expect(cleanEvidence({ rule_id: undefined, reference: null })).toBeNull()
  })

  it('stays inside the database cap', () => {
    const big = cleanEvidence({
      rule_id: 'r'.repeat(120),
      reference: 'x'.repeat(200),
      score: 1,
      receipt_id: OP_ID,
      pending_operation_id: OP_ID,
      source_system: 's'.repeat(60),
    })
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(MAX_LINK_EVIDENCE_BYTES)
  })
})

describe('readLinkBasis', () => {
  it('reads a recorded basis and its evidence', () => {
    expect(readLinkBasis({ link_basis: 'rule_amount_date', link_evidence: { rule_id: 'auto_exact', score: 0.95 } })).toEqual({
      basis: 'rule_amount_date',
      evidence: { rule_id: 'auto_exact', score: 0.95 },
    })
  })

  it('reads a legacy NULL row, or a value outside the vocabulary, as unknown', () => {
    expect(readLinkBasis({ link_basis: null, link_evidence: null })).toEqual({ basis: null, evidence: null })
    expect(readLinkBasis({ link_basis: 'guessed', link_evidence: ['x'] })).toEqual({ basis: null, evidence: null })
    expect(readLinkBasis(null)).toEqual({ basis: null, evidence: null })
  })
})

describe('vocabulary', () => {
  it('is closed and reserves the grant basis', () => {
    expect(LINK_BASES).toContain('agent_autonomous_within_grant')
    expect(isLinkBasis('user_confirmed')).toBe(true)
    expect(isLinkBasis('proven')).toBe(false)
  })

  it("maps the reconciliation matcher's methods", () => {
    expect(linkBasisForReconciliationMethod('auto_reference')).toBe('rule_ocr_reference')
    expect(linkBasisForReconciliationMethod('auto_exact')).toBe('rule_amount_date')
    expect(linkBasisForReconciliationMethod('auto_date_range')).toBe('rule_amount_date')
    expect(linkBasisForReconciliationMethod('auto_fuzzy')).toBe('rule_amount_date')
    expect(linkBasisForReconciliationMethod('manual')).toBe('user_confirmed')
    expect(linkBasisForReconciliationMethod(null)).toBe('rule_amount_date')
  })
})
