import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { conflictingVoucherClaims, loadDocumentClaims, loadDocumentClaimsAndWaitingLinks, sharedDocumentWarning } from '../document-claims'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
beforeEach(() => reset())

describe('loadDocumentClaims', () => {
  it('collects waiting links (single and batch) and transactions the document is attached to', async () => {
    enqueue({ data: [
      { id: 'op-a', params: { document_id: 'doc-1', transaction_id: 'tx-1' } },
      { id: 'op-b', params: { links: [{ document_id: 'doc-2', journal_entry_id: 'je-9' }, { document_id: 'doc-other', journal_entry_id: 'je-8' }] } },
    ] })
    enqueue({ data: [{ id: 'tx-7', document_id: 'doc-1' }] })
    const claims = await loadDocumentClaims(supabase as never, 'company-a', ['doc-1', 'doc-2'])
    expect(claims.get('doc-1')).toEqual([
      { document_id: 'doc-1', operation_id: 'op-a', transaction_id: 'tx-1', journal_entry_id: null },
      { document_id: 'doc-1', operation_id: null, transaction_id: 'tx-7', journal_entry_id: null },
    ])
    expect(claims.get('doc-2')).toEqual([{ document_id: 'doc-2', operation_id: 'op-b', transaction_id: null, journal_entry_id: 'je-9' }])
    expect(claims.has('doc-other')).toBe(false)
  })

  it('asks nothing when there are no documents', async () => {
    expect((await loadDocumentClaims(supabase as never, 'company-a', [])).size).toBe(0)
  })

  // crm#1207: a copy row archives a new file at approval; the document
  // itself stays free, so it is no claim another link could collide with.
  it('skips the copy rows of a waiting batch', async () => {
    enqueue({ data: [
      { id: 'op-c', params: { links: [{ document_id: 'doc-1', journal_entry_id: 'je-27', copy: true }, { document_id: 'doc-1', journal_entry_id: 'je-2' }] } },
    ] })
    enqueue({ data: [] })
    const claims = await loadDocumentClaims(supabase as never, 'company-a', ['doc-1'])
    expect(claims.get('doc-1')).toEqual([{ document_id: 'doc-1', operation_id: 'op-c', transaction_id: null, journal_entry_id: 'je-2' }])
  })

  // crm#1171 item 9: a single link staged as a copy leaves the document free too.
  it('skips a waiting single link staged as a copy', async () => {
    enqueue({ data: [
      { id: 'op-s', operation_type: 'link_document_to_voucher', params: { document_id: 'doc-1', journal_entry_id: 'je-23', copy: true } },
    ] })
    enqueue({ data: [] })
    const claims = await loadDocumentClaims(supabase as never, 'company-a', ['doc-1'])
    expect(claims.has('doc-1')).toBe(false)
  })

  it('counts the single voucher links waiting, from the same read', async () => {
    enqueue({ data: [
      { id: 'op-1', operation_type: 'link_document_to_voucher', params: { document_id: 'doc-8', journal_entry_id: 'je-8' } },
      { id: 'op-2', operation_type: 'link_document_to_voucher', params: { document_id: 'doc-9', journal_entry_id: 'je-9' } },
      { id: 'op-3', operation_type: 'link_documents_to_vouchers', params: { links: [] } },
      { id: 'op-4', operation_type: 'attach_document_to_transaction', params: { document_id: 'doc-7', transaction_id: 'tx-7' } },
    ] })
    enqueue({ data: [] })
    const { claims, waitingVoucherLinks } = await loadDocumentClaimsAndWaitingLinks(supabase as never, 'company-a', ['doc-1'])
    expect(waitingVoucherLinks).toBe(2)
    expect(claims.size).toBe(0)
  })
})

describe('sharedDocumentWarning', () => {
  const pendingFirst = { document_id: 'doc-1', operation_id: '9d329d0d-061f', transaction_id: '331ace55-cc90', journal_entry_id: null }

  // crm#1950: a document sits on one bank row at a time, so two attaches of
  // it never both hold: the later approval moves it. The warning used to
  // invite approving both for an invoice paid in parts, and both rows then
  // kept the document until one booking took it.
  it('warns when the same invoice is proposed for the twin charge: the later approval gets it', () => {
    const note = sharedDocumentWarning([pendingFirst], { transaction_id: '9158cf8d-11de' })
    expect(note).toContain('förslag 9d329d0d')
    expect(note).toContain('banktransaktion 331ace55')
    expect(note).toContain('en banktransaktion i taget')
    expect(note).toContain('godkänns sist')
    expect(note).not.toMatch(/Godkänn båda/)
    // An invoice paid in parts: a copy on the second verifikat, never two rows sharing one document.
    expect(note).toContain('betalats i flera delar')
    expect(note).toContain('exakt kopia')
  })

  it('says the document moves here when another bank transaction already holds it', () => {
    const attached = { document_id: 'doc-1', operation_id: null, transaction_id: 'abcdef12-3456', journal_entry_id: null }
    const note = sharedDocumentWarning([attached], { transaction_id: '9158cf8d-11de' })
    expect(note).toContain('banktransaktion abcdef12')
    expect(note).toContain('flyttas underlaget hit och den andra transaktionen blir utan')
    expect(note).not.toContain('godkänns sist')
    expect(note).not.toMatch(/Godkänn båda/)
  })

  // crm#1158: once a verifikat is on either side, only one verifikat can ever
  // hold the document, so the warning must not invite approving both.
  it('never invites approving both when a verifikat is involved, and says a statement needs a copy per verifikat', () => {
    const pendingVoucher = { document_id: 'doc-1', operation_id: '7a1b2c3d-0000', transaction_id: null, journal_entry_id: 'e1e2e3e4-0000' }
    for (const note of [
      sharedDocumentWarning([pendingVoucher], { transaction_id: '9158cf8d-11de' }),
      sharedDocumentWarning([pendingFirst], { journal_entry_id: 'je-1' }),
    ]) {
      expect(note).toContain('Ett underlag kan bara kopplas till en verifikation')
      expect(note).toContain('egen kopia per verifikation')
      expect(note).toContain('koppla en exakt kopia')
      expect(note).not.toContain('ladda upp')
      expect(note).not.toContain('flera delar')
      expect(note).not.toMatch(/Godkänn båda/)
    }
    expect(sharedDocumentWarning([pendingVoucher], { transaction_id: '9158cf8d-11de' })).toContain('förslag 7a1b2c3d (verifikat e1e2e3e4)')
  })

  it('does not warn about the link being staged itself', () => {
    expect(sharedDocumentWarning([pendingFirst], { transaction_id: '331ace55-cc90' })).toBeNull()
    expect(sharedDocumentWarning([], { transaction_id: 'tx-1' })).toBeNull()
  })

  it('names a transaction the document is already attached to', () => {
    const note = sharedDocumentWarning([{ document_id: 'doc-1', operation_id: null, transaction_id: 'abcdef12-3456', journal_entry_id: null }], { journal_entry_id: 'je-1' })
    expect(note).toContain('banktransaktion abcdef12')
  })
})

describe('conflictingVoucherClaims', () => {
  const claim = (over: Partial<{ operation_id: string | null; transaction_id: string | null; journal_entry_id: string | null }>) => ({
    document_id: 'doc-1', operation_id: null, transaction_id: null, journal_entry_id: null, ...over,
  })

  it('returns a waiting link to a different verifikat: only one of the two could ever commit (crm#1158)', () => {
    const other = claim({ operation_id: 'op-a', journal_entry_id: 'je-other' })
    expect(conflictingVoucherClaims([other], 'je-target')).toEqual([other])
  })

  it('ignores a waiting link to the same verifikat, a waiting bank-transaction link and a transaction the document is pinned to', () => {
    expect(conflictingVoucherClaims([
      claim({ operation_id: 'op-a', journal_entry_id: 'je-target' }),
      claim({ operation_id: 'op-b', transaction_id: 'tx-1' }),
      claim({ transaction_id: 'tx-2' }),
    ], 'je-target')).toEqual([])
  })
})
