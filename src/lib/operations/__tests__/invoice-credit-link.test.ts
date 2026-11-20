/**
 * invoices.link-credit-note (crm#1852): the operation's contract and what the
 * approver is shown. The rule is pinned in
 * lib/invoices/__tests__/link-credit-note.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { invoicesLinkCreditNote, linkCreditNoteTitle } from '../invoice-credit-link'

describe('invoices.link-credit-note: contract', () => {
  it('is an irreversible invoices:write that stages over MCP as link_credit_note_to_invoice', () => {
    expect(invoicesLinkCreditNote.kind).toBe('write')
    expect(invoicesLinkCreditNote.scope).toBe('invoices:write')
    expect(invoicesLinkCreditNote.risk).toBe('medium')
    expect(invoicesLinkCreditNote.reversible).toBe(false)
    expect(invoicesLinkCreditNote.http).toMatchObject({
      method: 'POST',
      path: '/api/v1/companies/:companyId/invoices/:id/link-credit-note',
      pathParams: { id: 'invoice_id' },
    })
    expect(invoicesLinkCreditNote.mcp?.name).toBe('gnubok_link_credit_note_to_invoice')
    expect(invoicesLinkCreditNote.mcp?.stage?.pendingType).toBe('link_credit_note_to_invoice')
    expect(OPERATION_RISK_TIERS.link_credit_note_to_invoice).toBe('medium')
    // Search-only: reachable through the stage bridge, no tools/list cost.
    expect(invoicesLinkCreditNote.mcp?.visibility).toBeUndefined()
  })

  it('needs both ids as UUIDs', () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    expect(invoicesLinkCreditNote.input.safeParse({ invoice_id: id }).success).toBe(false)
    expect(invoicesLinkCreditNote.input.safeParse({ invoice_id: id, credit_note_id: 'x' }).success).toBe(false)
    expect(invoicesLinkCreditNote.input.safeParse({ invoice_id: id, credit_note_id: id }).success).toBe(true)
  })

  it('titles the approval after the two documents', () => {
    expect(linkCreditNoteTitle({ credit_note_number: '1043', invoice_number: '1042' })).toBe(
      'Koppla kreditfaktura 1043 till faktura 1042',
    )
    expect(linkCreditNoteTitle({ credit_note_number: null, invoice_number: ' ' })).toBe('Koppla kreditfaktura till faktura')
    expect(linkCreditNoteTitle(undefined)).toBe('Koppla kreditfaktura till faktura')
  })
})
