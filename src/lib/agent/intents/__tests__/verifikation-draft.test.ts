import { describe, it, expect, vi } from 'vitest'
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

// The shared mock Supabase harnesses proxy every chained call and never look at
// the argument, so a select() naming a column that does not exist looks
// identical to a correct one. These tests therefore record the select strings
// and assert against the real schema:
//   journal_entry_lines: line_description (NOT description)
//   fiscal_periods:      is_closed + locked_at (NOT status / locked_through)
type StubResult = { data?: unknown; error?: unknown; throws?: Error }

function createRecordingSupabase(byTable: Record<string, StubResult[]>) {
  const selects: { table: string; columns: string }[] = []

  const chainFor = (table: string, result: StubResult): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              if (result.throws) {
                reject(result.throws)
                return
              }
              resolve({ data: result.data ?? null, error: result.error ?? null })
            }
          }
          return (...args: unknown[]) => {
            if (prop === 'select') selects.push({ table, columns: String(args[0] ?? '') })
            return proxy
          }
        },
      },
    )
    return proxy
  }

  const supabase = {
    from: (table: string) => chainFor(table, byTable[table]?.shift() ?? {}),
  }

  return { supabase: supabase as never, selects }
}

const DRAFT_ENTRY = { id: 'e1', entry_date: '2026-05-01', description: 'Inköp', status: 'draft' }

function stubs(overrides: Partial<Record<string, StubResult[]>> = {}): Record<string, StubResult[]> {
  return {
    journal_entries: [{ data: DRAFT_ENTRY }],
    journal_entry_lines: [
      {
        data: [
          {
            account_number: '5410',
            debit_amount: 500,
            credit_amount: null,
            line_description: 'Förbrukningsinventarier',
          },
        ],
      },
    ],
    company_settings: [{ data: null }],
    fiscal_periods: [{ data: { id: 'p1', is_closed: false, locked_at: null } }],
    document_attachments: [{ data: [] }],
    ...overrides,
  }
}

async function captureWith(byTable: Record<string, StubResult[]>) {
  const { supabase, selects } = createRecordingSupabase(byTable)
  const captured = await verifikationDraft.capture(
    { journal_entry_id: 'e1' },
    { supabase, userId: 'u1', companyId: 'c1' },
  )
  const prompt = verifikationDraft.promptTemplate({ captured, profileSummary: null, activeMemory: [] })
  return { captured, prompt, selects }
}

describe('verifikation.draft capture selects columns that exist', () => {
  it('reads journal_entry_lines.line_description, not a non-existent description column', async () => {
    const { captured, selects } = await captureWith(stubs())

    const lineSelect = selects.find((s) => s.table === 'journal_entry_lines')
    expect(lineSelect).toBeDefined()
    expect(lineSelect!.columns).toContain('line_description')
    // A bare `description` would make PostgREST reject the whole select, which
    // is what made the agent see a verifikation with zero rader.
    expect(lineSelect!.columns).not.toMatch(/(^|[\s,])description/)

    // ...and the per-line text still reaches the prompt shape.
    expect(captured.current_lines).toEqual([
      {
        account_number: '5410',
        debit_amount: 500,
        credit_amount: null,
        description: 'Förbrukningsinventarier',
      },
    ])
  })

  it('resolves the lock state from the real two-layer source, not fiscal_periods.status/locked_through', async () => {
    const { selects } = await captureWith(stubs())

    // Layer 1: company-wide lock date.
    const settingsSelect = selects.find((s) => s.table === 'company_settings')
    expect(settingsSelect?.columns).toContain('bookkeeping_locked_through')

    // Layer 2: the covering fiscal period.
    const periodSelect = selects.find((s) => s.table === 'fiscal_periods')
    expect(periodSelect).toBeDefined()
    expect(periodSelect!.columns).toContain('is_closed')
    expect(periodSelect!.columns).toContain('locked_at')
    expect(periodSelect!.columns).not.toContain('locked_through')
    expect(periodSelect!.columns).not.toContain('status')
  })
})

describe('verifikation.draft period lock gate', () => {
  it('stays silent about locks for an open period', async () => {
    const { captured, prompt } = await captureWith(stubs())

    expect(captured.period_status).toEqual({ period_id: 'p1', status: 'open', lock_date: null })
    expect(prompt).not.toContain('PERIODEN ÄR LÅST')
    expect(prompt).not.toContain('PERIODEN ÄR STÄNGD')
    expect(prompt).not.toContain('PERIODLÅSET KUNDE INTE LÄSAS')
  })

  it('refuses a locked period (fiscal_periods.locked_at)', async () => {
    const { captured, prompt } = await captureWith(
      stubs({ fiscal_periods: [{ data: { id: 'p1', is_closed: false, locked_at: '2026-06-01T09:00:00Z' } }] }),
    )

    expect(captured.period_status?.status).toBe('locked')
    expect(prompt).toContain('PERIODEN ÄR LÅST')
  })

  it('refuses a date behind the company-wide lock date', async () => {
    const { captured, prompt } = await captureWith(
      stubs({ company_settings: [{ data: { bookkeeping_locked_through: '2026-06-30' } }] }),
    )

    expect(captured.period_status?.status).toBe('locked')
    expect(captured.period_status?.lock_date).toBe('2026-06-30')
    expect(prompt).toContain('PERIODEN ÄR LÅST')
  })

  it('refuses a closed period and does not offer to unlock it', async () => {
    const { captured, prompt } = await captureWith(
      stubs({ fiscal_periods: [{ data: { id: 'p1', is_closed: true, locked_at: '2026-06-01T09:00:00Z' } }] }),
    )

    expect(captured.period_status?.status).toBe('closed')
    expect(prompt).toContain('PERIODEN ÄR STÄNGD')
    // A closed period cannot be unlocked (period-service rejects it), so the
    // agent must not send the user to Räkenskapsår to try.
    expect(prompt).not.toContain('låsa upp perioden')
  })

  it('fails closed when the lock lookup errors', async () => {
    const { captured, prompt } = await captureWith(
      stubs({ company_settings: [{ throws: new Error('PostgREST 500') }] }),
    )

    // Never 'open': an unreadable lock state must not read as postable.
    expect(captured.period_status?.status).toBe('unknown')
    expect(prompt).toContain('PERIODLÅSET KUNDE INTE LÄSAS')
    expect(prompt).toContain('utgå INTE från att perioden är öppen')
  })

  it('renders a SOFT lookup failure as unknown, never as a real lock', async () => {
    // resolvePeriodStatusForDate does not throw on a PostgREST error result:
    // it returns { status: 'locked', lookup_failed: true } (fail-closed for
    // write gates). This surface must branch on lookup_failed: a transient DB
    // blip must not tell the user "PERIODEN ÄR LÅST ... låsa upp perioden"
    // about a lock that may not exist.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { captured, prompt } = await captureWith(
        stubs({ company_settings: [{ data: null, error: { message: 'connection reset' } }] }),
      )

      expect(captured.period_status?.status).toBe('unknown')
      expect(prompt).toContain('PERIODLÅSET KUNDE INTE LÄSAS')
      expect(prompt).not.toContain('PERIODEN ÄR LÅST')
      expect(prompt).not.toContain('låsa upp perioden')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('points a posted entry in a locked period at storno, never at an inline rewrite', async () => {
    // BFL 5 kap 5 §: inline rättelse is only legal while the period is open and
    // unlocked. Past a lock/close, storno is the only sanctioned track.
    const { prompt } = await captureWith(
      stubs({
        journal_entries: [{ data: { ...DRAFT_ENTRY, status: 'posted' } }],
        fiscal_periods: [{ data: { id: 'p1', is_closed: false, locked_at: '2026-06-01T09:00:00Z' } }],
      }),
    )

    expect(prompt).toContain('storno')
    expect(prompt).toContain('BFL 5 kap 5 §')
  })

  it('does not push storno at a posted entry while the period is open', async () => {
    const { prompt } = await captureWith(
      stubs({ journal_entries: [{ data: { ...DRAFT_ENTRY, status: 'posted' } }] }),
    )

    expect(prompt).not.toContain('BFL 5 kap 5 §')
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
