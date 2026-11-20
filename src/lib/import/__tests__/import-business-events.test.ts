import { describe, expect, it } from 'vitest'
import { buildRow } from '@/lib/posting/port'
import {
  openingBalanceBusinessEvent,
  openingBalanceStornoBusinessEvent,
  sieImportBusinessEvent,
} from '../import-business-events'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const PERIOD = '22222222-2222-4222-8222-222222222222'
const JOB = '33333333-3333-4333-8333-333333333333'
const OP = '44444444-4444-4444-8444-444444444444'
const newId = () => '55555555-5555-4555-8555-555555555555'

describe('the business events of imports and opening balances', () => {
  it('an IB: ledger.opening_balance on the year\'s first day, subject the year, no amount', () => {
    const row = buildRow(
      COMPANY,
      openingBalanceBusinessEvent(PERIOD, '2026-01-01', {
        link_basis: 'agent_proposed_user_approved',
        link_evidence: { pending_operation_id: OP },
      }),
      newId,
      null,
    )
    expect(row).toMatchObject({
      kind: 'ledger.opening_balance',
      category: null,
      occurred_on: '2026-01-01',
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      party_type: null,
      currency: null,
      amount: null,
      amount_sek: null,
      mapping_version: null,
      pending_operation_id: OP,
      evidence: { link_basis: 'agent_proposed_user_approved', link_evidence: { pending_operation_id: OP } },
      idempotency_key: null,
    })
  })

  it('a storno of an IB: ledger.storno, dated the day, subject the year', () => {
    const row = buildRow(
      COMPANY,
      openingBalanceStornoBusinessEvent(PERIOD, '2026-10-18', { link_basis: 'system_derived', link_evidence: null }),
      newId,
      null,
    )
    expect(row).toMatchObject({
      kind: 'ledger.storno',
      occurred_on: '2026-10-18',
      subject_type: 'fiscal_period',
      subject_id: PERIOD,
      pending_operation_id: null,
      evidence: { link_basis: 'system_derived' },
    })
  })

  it('an import job: ONE ledger.history_import, subject the job, keyed by the job, references only', () => {
    const row = buildRow(COMPANY, sieImportBusinessEvent({ id: JOB, file_hash: 'f'.repeat(64) }, 1204, '2026-10-18'), newId, null)
    expect(row).toMatchObject({
      kind: 'ledger.history_import',
      category: null,
      occurred_on: '2026-10-18',
      subject_type: 'sie_import',
      subject_id: JOB,
      party_type: null,
      amount: null,
      amount_sek: null,
      tax_amounts: [],
      mapping_version: null,
      evidence: { link_basis: 'import_carried_over', file_hash: 'f'.repeat(64), voucher_count: 1204 },
      idempotency_key: `ledger.history_import:sie_import:${JOB}`,
      actor_type: null,
    })
  })
})
