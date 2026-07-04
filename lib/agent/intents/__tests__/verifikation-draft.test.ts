import { describe, it, expect } from 'vitest'
import { verifikationDraft } from '../verifikation-draft'

// verifikation.draft is the assistant entry point on the manual bookkeeping
// surfaces (Bokföring → "Skapa med assistent", the Ny verifikat-dialog handoff,
// and a draft verifikat's own page). These tests lock in the two things that
// make it actually useful:
//   1. it carries the underlag-reading tools its ground rules already reference
//      (the intent shipped without them: instructions for tools it couldn't
//      call), and
//   2. the prompt drives "read the underlag → suggest accounts → stage a
//      voucher", while guarding against duplicating an existing draft (there's
//      no MCP edit-draft tool, so for an existing draft the agent must advise,
//      not stage a second verifikat).

type Captured = Parameters<typeof verifikationDraft.promptTemplate>[0]['captured']

function baseCaptured(overrides: Partial<Captured> = {}): Captured {
  return {
    entry: null,
    current_lines: [],
    period_status: null,
    description_hint: null,
    underlag: [],
    ...overrides,
  }
}

function renderPrompt(overrides: Partial<Captured> = {}, profileSummary: string | null = null): string {
  return verifikationDraft.promptTemplate({
    captured: baseCaptured(overrides),
    profileSummary,
    activeMemory: [],
  })
}

describe('verifikation.draft tool scope', () => {
  it('carries the underlag-reading tools its ground rules reference', () => {
    // shared-rules.ts tells the agent to call gnubok_list_inbox_items /
    // gnubok_get_document_content before proposing a booking. The intent
    // originally omitted them, so those instructions were dead. Lock them in.
    expect(verifikationDraft.tools).toContain('gnubok_get_document_content')
    expect(verifikationDraft.tools).toContain('gnubok_list_inbox_items')
    expect(verifikationDraft.tools).toContain('gnubok_get_inbox_item')
    expect(verifikationDraft.tools).toContain('gnubok_list_unmatched_documents')
  })

  it('can still stage the voucher', () => {
    expect(verifikationDraft.tools).toContain('gnubok_create_voucher')
  })
})

describe('verifikation.draft prompt template', () => {
  it('renders the shared ground rules (underlag-first discipline)', () => {
    const out = renderPrompt()
    expect(out).toContain('UNDERLAG FÖRST')
  })

  it('tells the agent to read the underlag before proposing accounts', () => {
    const out = renderPrompt()
    expect(out).toContain('UNDERLAG FÖRST.')
    expect(out).toContain('gnubok_list_inbox_items')
    expect(out).toContain('gnubok_get_document_content')
  })

  it('stages a new voucher and links the inbox underlag to it', () => {
    const out = renderPrompt()
    expect(out).toContain('gnubok_create_voucher')
    // The kvitto must follow the booking: create_voucher takes inbox_item_id
    // and attaches the OCR document on commit.
    expect(out).toContain('inbox_item_id')
  })

  it('guards against duplicating an existing draft', () => {
    // No MCP tool edits a draft in place, so for an existing draft the agent
    // must advise (suggest accounts / check balance) rather than stage a
    // second verifikat, otherwise "help me finish this draft" creates a dupe.
    const out = renderPrompt({
      entry: { id: 'e1', entry_date: '2026-05-01', description: 'Utkast', status: 'draft' },
    })
    expect(out).toContain('Staga INTE en ny verifikation för ett utkast som redan finns')
  })

  it('surfaces extracted underlag fields so the agent does not re-ask', () => {
    const out = renderPrompt({
      entry: { id: 'e1', entry_date: '2026-05-01', description: 'Inköp', status: 'draft' },
      underlag: [
        {
          document_id: 'doc-1',
          file_name: 'kvitto.pdf',
          merchant_name: 'Clas Ohlson',
          receipt_date: '2026-05-01',
          total_amount: 499,
          vat_amount: 99.8,
          currency: 'SEK',
          raw_extraction: null,
        },
      ],
    })
    expect(out).toContain('UNDERLAG kopplat till verifikationen')
    expect(out).toContain('Clas Ohlson')
    expect(out).toContain('document_id=doc-1')
  })

  it('warns when the entry sits in a locked period', () => {
    const out = renderPrompt({
      entry: { id: 'e1', entry_date: '2025-12-31', description: 'Inköp', status: 'draft' },
      period_status: { period_id: 'p1', status: 'locked', lock_date: '2025-12-31' },
    })
    expect(out).toContain('PERIODEN ÄR LÅST')
  })

  it('flags an unbalanced set of existing lines', () => {
    const out = renderPrompt({
      entry: { id: 'e1', entry_date: '2026-05-01', description: 'Inköp', status: 'draft' },
      current_lines: [
        { account_number: '5410', debit_amount: 500, credit_amount: null, description: 'Förbrukning' },
        { account_number: '1930', debit_amount: null, credit_amount: 400, description: 'Bank' },
      ],
    })
    expect(out).toContain('debet ≠ kredit')
  })
})

describe('verifikation.draft capture', () => {
  it('returns an empty draft (with an underlag array) when no entry id is given', async () => {
    // The fresh-start path (Bokföring → "Skapa med assistent") passes no
    // journal_entry_id and must not touch the database: the agent discovers
    // underlag itself via the inbox tools.
    const captured = await verifikationDraft.capture(
      { description: 'Köp av router' },
      { supabase: {} as never, userId: 'u1', companyId: 'c1' },
    )
    expect(captured.entry).toBeNull()
    expect(captured.current_lines).toEqual([])
    expect(captured.underlag).toEqual([])
    expect(captured.description_hint).toBe('Köp av router')
  })
})
