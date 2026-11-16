import { describe, expect, it } from 'vitest'
import { describeRecord, isRecordId, isWikiRecordKind, linkedRecordHref, nativeRecordHref, parseRecordRef } from '../wiki-record'

const JE = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const DOC2 = '22222222-2222-4222-8222-333333333333'
const TX = '33333333-3333-4333-8333-333333333333'
const INV = '44444444-4444-4444-8444-444444444444'
const OP = '55555555-5555-4555-8555-555555555555'
const AGR = '66666666-6666-4666-8666-666666666666'
const PARTY = '77777777-7777-4777-8777-777777777777'

describe('record kinds and refs', () => {
  it('opens what get_record opens on main', () => {
    expect(['document', 'journal_entry', 'agreement', 'party', 'fact'].every(isWikiRecordKind)).toBe(true)
    expect(isWikiRecordKind('invoice')).toBe(false)
    expect(isRecordId(JE)).toBe(true)
    expect(isRecordId('x')).toBe(false)
  })

  it('parses a record_ref and refuses anything else', () => {
    expect(parseRecordRef(`document:${DOC}`)).toEqual({ kind: 'document', id: DOC })
    expect(parseRecordRef(`skattekonto_transaction:${TX}`)).toEqual({ kind: 'skattekonto_transaction', id: TX })
    expect(parseRecordRef('document:nope')).toBeNull()
    expect(parseRecordRef(DOC)).toBeNull()
    expect(parseRecordRef(null)).toBeNull()
  })

  it('opens a linked record on its wiki page, else on its page in the app', () => {
    expect(linkedRecordHref('document', DOC)).toBe(`/wiki/document/${DOC}`)
    expect(linkedRecordHref('transaction', TX)).toBe(`/transactions?highlight=${TX}`)
    expect(linkedRecordHref('invoice', INV)).toBe(`/invoices/${INV}`)
    expect(linkedRecordHref('supplier_invoice', INV)).toBe(`/supplier-invoices/${INV}`)
    expect(linkedRecordHref('ledger_settlement', INV)).toBeNull()
    expect(nativeRecordHref('journal_entry', JE)).toBe(`/bookkeeping/${JE}`)
    expect(nativeRecordHref('document', DOC)).toBe(`/api/documents/${DOC}/inline`)
  })
})

describe('describeRecord: journal_entry', () => {
  const answer = {
    record_ref: `journal_entry:${JE}`,
    kind: 'journal_entry',
    journal_entry: {
      journal_entry_id: JE,
      voucher: 'A12',
      entry_date: '2026-10-28',
      description: 'Internet oktober',
      documents: [
        { document_id: DOC, file_name: 'faktura.pdf', duplicate_of: null },
        { document_id: DOC2, file_name: 'faktura (1).pdf', duplicate_of: `document:${DOC}` },
      ],
      decision: {
        receipt_id: 'r1',
        decided_at: '2026-10-29T08:00:00Z',
        outcome: 'accepted',
        decided_by: { actor_type: 'user' },
        proposed_by: { pending_operation_id: OP, actor_type: 'api_key', label: 'Claude', model: 'claude-x' },
        agent_reason: 'Samma leverantör som förra månaden.',
        evidence: {},
      },
      links: [
        { kind: 'bank_transaction', transaction_id: TX, via: 'pointer', basis: 'user_confirmed' },
        { kind: 'document', document_id: DOC, basis: 'agent_proposed_user_approved' },
        { kind: 'invoice_payment', invoice_payment_id: OP, invoice_id: INV, basis: null },
        { kind: 'ledger_settlement', settlement_id: OP, basis: 'system_derived' },
      ],
    },
  }
  const view = describeRecord('journal_entry', JE, answer)

  it('titles the page with the voucher and lists its fields from the books', () => {
    expect(view.title).toBe('A12')
    expect(view.record_ref).toBe(`journal_entry:${JE}`)
    expect(view.fields).toEqual([
      { label: 'voucher', value: 'A12', source: 'ledger' },
      { label: 'entry_date', value: '2026-10-28', source: 'ledger' },
      { label: 'description', value: 'Internet oktober', source: 'ledger' },
    ])
    expect(view.native_href).toBe(`/bookkeeping/${JE}`)
  })

  it('lists every link once, with its basis and where it opens', () => {
    expect(view.links).toEqual([
      { relation: 'underlag', target_kind: 'document', target_id: DOC, label: 'faktura.pdf', basis: 'agent_proposed_user_approved', href: `/wiki/document/${DOC}`, duplicate: false },
      { relation: 'underlag', target_kind: 'document', target_id: DOC2, label: 'faktura (1).pdf', basis: null, href: `/wiki/document/${DOC2}`, duplicate: true },
      { relation: 'bank_row', target_kind: 'transaction', target_id: TX, label: null, basis: 'user_confirmed', href: `/transactions?highlight=${TX}`, duplicate: false },
      { relation: 'invoice_payment', target_kind: 'invoice', target_id: INV, label: null, basis: null, href: `/invoices/${INV}`, duplicate: false },
      { relation: 'settlement', target_kind: 'ledger_settlement', target_id: null, label: null, basis: 'system_derived', href: null, duplicate: false },
    ])
  })

  it('names who kept it current from the decision get_record returns', () => {
    expect(view.maintainer).toEqual({
      decided_at: '2026-10-29T08:00:00Z',
      outcome: 'accepted',
      decided_by: { actor_type: 'user', label: null },
      proposed_by: { actor_type: 'api_key', label: 'Claude', model: 'claude-x', pending_operation_id: OP },
      agent_reason: 'Samma leverantör som förra månaden.',
    })
  })

  it('has no maintainer when nothing recorded a decision, and says when links could not be read', () => {
    const plain = describeRecord('journal_entry', JE, { journal_entry: { voucher: 'A1', documents: [], links_unavailable: true } })
    expect(plain.maintainer).toBeNull()
    expect(plain.links).toEqual([])
    expect(plain.links_unavailable).toBe(true)
  })

  it('reads links written as record_refs (the shape accounted MR !1324 returns)', () => {
    const v = describeRecord('journal_entry', JE, {
      journal_entry: { voucher: 'A1', documents: [], links: [{ relation: 'pays', record_ref: `supplier_invoice:${INV}`, basis: 'rule_ocr_reference' }], books: [{ relation: 'books', record_ref: `invoice:${INV}` }] },
    })
    expect(v.links).toEqual([
      { relation: 'pays', target_kind: 'supplier_invoice', target_id: INV, label: null, basis: 'rule_ocr_reference', href: `/supplier-invoices/${INV}`, duplicate: false },
      { relation: 'books', target_kind: 'invoice', target_id: INV, label: null, basis: null, href: `/invoices/${INV}`, duplicate: false },
    ])
  })
})

describe('describeRecord: document and brain kinds', () => {
  it('reads a document with the verifikat it sits on and its brain links', () => {
    const v = describeRecord('document', DOC, {
      document: {
        document_id: DOC,
        file_name: 'hyresavtal.pdf',
        created_at: '2026-01-02T10:00:00Z',
        doc_type: 'agreement',
        admission_state: 'admitted',
        page_count: 4,
        journal_entry_id: JE,
        links: [{ link_id: 'l1', record_ref: `party:${PARTY}`, basis: 'rule_counterparty', method: 'rule', confidence: 1 }],
        agreement_ref: `agreement:${AGR}`,
        raw_only: false,
      },
    })
    expect(v.title).toBe('hyresavtal.pdf')
    expect(v.fields.map((f) => f.label)).toEqual(['doc_type', 'received', 'page_count', 'admission_state'])
    expect(v.links).toEqual([
      { relation: 'verifikat', target_kind: 'journal_entry', target_id: JE, label: null, basis: null, href: `/wiki/journal_entry/${JE}`, duplicate: false },
      { relation: 'linked', target_kind: 'party', target_id: PARTY, label: null, basis: 'rule_counterparty', href: `/wiki/party/${PARTY}`, duplicate: false },
      { relation: 'agreement', target_kind: 'agreement', target_id: AGR, label: null, basis: null, href: `/wiki/agreement/${AGR}`, duplicate: false },
    ])
    expect(v.native_href).toBe(`/api/documents/${DOC}/inline`)
  })

  it('reads an agreement with its counterparty and source document', () => {
    const v = describeRecord('agreement', AGR, {
      agreement: { title: 'Hyresavtal', kind: 'lease', status: 'active', counterparty: { party_ref: `party:${PARTY}`, name: 'Fastighets AB' }, starts_on: '2026-01-01', ends_on: null, amount: 12000, currency: 'SEK', source_document_ref: `document:${DOC}` },
    })
    expect(v.title).toBe('Hyresavtal')
    expect(v.fields).toContainEqual({ label: 'amount', value: '12000 SEK', source: 'archive' })
    expect(v.links.map((l) => [l.relation, l.target_kind])).toEqual([['counterparty', 'party'], ['source_document', 'document']])
  })

  it('throws when the answer is for another kind', () => {
    expect(() => describeRecord('document', DOC, { journal_entry: {} })).toThrow()
  })
})
