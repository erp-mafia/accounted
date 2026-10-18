import { describe, expect, it } from 'vitest'
import { cleanBusinessEventEvidence, jsonbTextBytes, MAX_BUSINESS_EVENT_EVIDENCE_BYTES } from '../evidence'
import { projectBusinessEvent } from '../project'

const DOC = '0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b'
const OP = '7b3a0000-1111-4222-8333-444455556666'

describe('business event evidence', () => {
  it('keeps the closed fields and drops unknown or malformed ones, never throwing', () => {
    expect(
      cleanBusinessEventEvidence({
        document_id: DOC,
        inbox_item_id: 'not-a-uuid',
        template_id: 'it_saas_eu',
        link_basis: 'user_created',
        link_evidence: { pending_operation_id: OP },
        direction: 'out',
        supplier_name: 'Telia Sverige AB',
        personnummer: 'never-stored',
        rule_id: null,
        proposal_id: undefined,
      }),
    ).toEqual({
      document_id: DOC,
      template_id: 'it_saas_eu',
      link_basis: 'user_created',
      link_evidence: { pending_operation_id: OP },
      direction: 'out',
    })
    expect(cleanBusinessEventEvidence(undefined)).toEqual({})
    expect(cleanBusinessEventEvidence({ link_basis: 'made_up' })).toEqual({})
  })

  it('counts bytes the way the database CHECK does (jsonb text, with its spaces)', () => {
    // jsonb prints {"a": 1, "b": [1, 2]}: one space after every ':' and ','.
    expect(jsonbTextBytes({ a: 1, b: [1, 2] })).toBe('{"a": 1, "b": [1, 2]}'.length)
    expect(jsonbTextBytes({ å: 'ö' })).toBe(new TextEncoder().encode('{"å": "ö"}').length)
    expect(jsonbTextBytes({})).toBe(2)
  })

  it('keeps an import job\'s file hash and voucher count, and nothing that is not one', () => {
    expect(cleanBusinessEventEvidence({ link_basis: 'import_carried_over', file_hash: 'a'.repeat(64), voucher_count: 4 })).toEqual({
      link_basis: 'import_carried_over',
      file_hash: 'a'.repeat(64),
      voucher_count: 4,
    })
    expect(cleanBusinessEventEvidence({ file_hash: 'paritet-2026.se', voucher_count: -1 })).toEqual({})
    expect(cleanBusinessEventEvidence({ file_hash: 'A'.repeat(64), voucher_count: 2.5 })).toEqual({})
  })

  it('stays under the database cap', () => {
    const big = cleanBusinessEventEvidence({
      document_id: DOC,
      proposal_id: 'p'.repeat(120),
      template_id: 't'.repeat(120),
      link_evidence: { reference: 'r'.repeat(200), rule_id: 'x'.repeat(120), source_system: 's'.repeat(60) },
    })
    expect(jsonbTextBytes(big)).toBeLessThanOrEqual(MAX_BUSINESS_EVENT_EVIDENCE_BYTES)
  })
})

describe('projectBusinessEvent (history, no backfill)', () => {
  it('answers the kind, role, date and subject from what the verifikat states', () => {
    expect(
      projectBusinessEvent({ id: 'je-1', source_type: 'bank_transaction', source_id: DOC, entry_date: '2025-03-14' }),
    ).toEqual({
      source: 'projection',
      journal_entry_id: 'je-1',
      kind: 'bank.categorized',
      role: 'produced',
      occurred_on: '2025-03-14',
      subject: { type: 'transaction', id: DOC },
    })
    expect(
      projectBusinessEvent({ id: 'je-2', source_type: 'supplier_invoice_paid', source_id: DOC, entry_date: '2025-04-01' }).subject,
    ).toEqual({ type: 'supplier_invoice', id: DOC })
    expect(
      projectBusinessEvent({ id: 'je-3', source_type: 'credit_note', source_id: DOC, entry_date: '2025-04-01' }),
    ).toMatchObject({ kind: 'sale.credited', subject: { type: 'invoice', id: DOC } })
  })

  it('gives a storno the reversal role and no subject (its source_id is its original\'s)', () => {
    expect(
      projectBusinessEvent({ id: 'je-4', source_type: 'storno', source_id: DOC, entry_date: '2025-05-01' }),
    ).toMatchObject({ kind: 'ledger.storno', role: 'reversal', subject: null })
    expect(
      projectBusinessEvent({ id: 'je-5', source_type: 'correction', source_id: null, entry_date: '2025-05-01' }),
    ).toMatchObject({ kind: 'ledger.correction', role: 'correction', subject: null })
  })

  it('names the import job of an imported verifikat and of the IB the import booked, from its import batch', () => {
    const JOB = '6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a'
    expect(
      projectBusinessEvent({ id: 'je-8', source_type: 'import', source_id: null, entry_date: '2025-02-10', import_batch_id: JOB }),
    ).toMatchObject({ kind: 'ledger.history_import', role: 'produced', subject: { type: 'sie_import', id: JOB } })
    expect(
      projectBusinessEvent({ id: 'je-9', source_type: 'opening_balance', source_id: null, entry_date: '2025-01-01', import_batch_id: JOB }),
    ).toMatchObject({ kind: 'ledger.opening_balance', subject: { type: 'sie_import', id: JOB } })
    // An IB typed by hand has no import batch; an undo's storno is a storno.
    expect(
      projectBusinessEvent({ id: 'je-10', source_type: 'opening_balance', source_id: null, entry_date: '2025-01-01' }),
    ).toMatchObject({ kind: 'ledger.opening_balance', subject: null })
    expect(
      projectBusinessEvent({ id: 'je-11', source_type: 'storno', source_id: null, entry_date: '2025-02-10', import_batch_id: JOB }),
    ).toMatchObject({ kind: 'ledger.storno', role: 'reversal', subject: null })
  })

  it('projects a manual voucher as ledger.manual and an unknown source type as no kind', () => {
    expect(projectBusinessEvent({ id: 'je-6', source_type: 'manual', source_id: null, entry_date: '2025-01-01' })).toMatchObject({
      kind: 'ledger.manual',
      subject: null,
    })
    expect(
      projectBusinessEvent({ id: 'je-7', source_type: 'from_the_future' as never, source_id: DOC, entry_date: '2025-01-01' }),
    ).toMatchObject({ kind: null, subject: null })
  })
})
