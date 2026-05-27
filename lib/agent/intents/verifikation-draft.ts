import { defineAgentIntent } from './types'
import { SONNET_MODEL, THINKING_BUDGET_STANDARD } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'

// verifikation.draft — "Fråga [namn]" on the journal entry creation form.
//
// Helps the user construct a balanced verifikation: pick the right BAS
// accounts, handle VAT splits, and detect when a transaction should instead
// be matched to an invoice or supplier invoice (rather than booked from
// scratch). Reads any in-progress draft state passed via intent_args.

interface VerifikationDraftArgs {
  // Optional id when the user is editing an existing draft. null for /new.
  journal_entry_id?: string | null
  // Optional starter description from the form, so the agent can suggest
  // counterparty templates without round-tripping.
  description?: string | null
}

interface CapturedVerifikationDraft {
  entry: {
    id: string
    entry_date: string | null
    description: string | null
    status: string | null
  } | null
  current_lines: {
    account_number: string | null
    debit_amount: number | null
    credit_amount: number | null
    description: string | null
  }[]
  period_status: {
    period_id: string | null
    status: string | null
    lock_date: string | null
  } | null
  description_hint: string | null
}

export const verifikationDraft = defineAgentIntent<
  VerifikationDraftArgs,
  CapturedVerifikationDraft
>({
  id: 'verifikation.draft',
  buttonLabel: 'Fråga om denna verifikation',
  sheetTitle: 'Hjälp med verifikation',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-accounting-compliance', 'swedish-vat'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  tools: [
    'gnubok_get_trial_balance',
    'gnubok_query_journal',
    'gnubok_create_voucher',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  // Work out the entry (accounts, VAT, balance) in the thinking channel, so the
  // visible reply lands once — after the voucher is staged — instead of an
  // analysis before the tool call and a near-identical answer after it. The
  // always-on prompt promises "resonemang sker i tankekanalen"; without this
  // that channel doesn't exist and the reasoning spills into the visible reply.
  thinking: { budgetTokens: THINKING_BUDGET_STANDARD },

  capture: async ({ journal_entry_id, description }, { supabase, companyId }) => {
    let entry: CapturedVerifikationDraft['entry'] = null
    let lines: CapturedVerifikationDraft['current_lines'] = []
    let periodStatus: CapturedVerifikationDraft['period_status'] = null

    if (journal_entry_id) {
      const { data: e } = await supabase
        .from('journal_entries')
        .select('id, entry_date, description, status')
        .eq('id', journal_entry_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (e) {
        entry = {
          id: (e as { id: string }).id,
          entry_date: ((e as { entry_date?: string | null }).entry_date) ?? null,
          description: ((e as { description?: string | null }).description) ?? null,
          status: ((e as { status?: string | null }).status) ?? null,
        }
        const { data: rows } = await supabase
          .from('journal_entry_lines')
          .select('account_number, debit_amount, credit_amount, description')
          .eq('journal_entry_id', journal_entry_id)
          .order('id', { ascending: true })
        lines = (rows ?? []) as CapturedVerifikationDraft['current_lines']
        const entryDate = entry?.entry_date ?? null
        if (entryDate) {
          const { data: period } = await supabase
            .from('fiscal_periods')
            .select('id, status, locked_through')
            .eq('company_id', companyId)
            .lte('period_start', entryDate)
            .gte('period_end', entryDate)
            .maybeSingle()
          if (period) {
            periodStatus = {
              period_id: (period as { id: string }).id,
              status: ((period as { status?: string | null }).status) ?? null,
              lock_date: ((period as { locked_through?: string | null }).locked_through) ?? null,
            }
          }
        }
      }
    }

    return {
      entry,
      current_lines: lines,
      period_status: periodStatus,
      description_hint: description ?? null,
    }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push('Användaren skapar eller redigerar en verifikation.')
    if (captured.entry) {
      lines.push(
        `Verifikation: ${captured.entry.id} (${captured.entry.entry_date ?? '?'}, status ${captured.entry.status ?? '?'})`,
      )
      if (captured.entry.description) lines.push(`Beskrivning: ${captured.entry.description}`)
    } else if (captured.description_hint) {
      lines.push(`Användarens beskrivning än så länge: "${captured.description_hint}"`)
    } else {
      lines.push('Ny verifikation, inga rader än.')
    }
    lines.push('')
    lines.push(renderAgentGroundRules())
    lines.push('')

    if (captured.current_lines.length > 0) {
      lines.push('')
      lines.push('Befintliga rader:')
      let debits = 0
      let credits = 0
      for (const r of captured.current_lines) {
        const d = r.debit_amount ?? 0
        const c = r.credit_amount ?? 0
        debits += d
        credits += c
        const dStr = d > 0 ? d.toLocaleString('sv-SE') : ''
        const cStr = c > 0 ? c.toLocaleString('sv-SE') : ''
        lines.push(`  ${r.account_number ?? '????'}  ${dStr.padStart(12)}  ${cStr.padStart(12)}  ${r.description ?? ''}`)
      }
      lines.push(`  SUMMA          ${debits.toLocaleString('sv-SE').padStart(12)}  ${credits.toLocaleString('sv-SE').padStart(12)}`)
      if (Math.abs(debits - credits) > 0.005) {
        lines.push(`  ⚠ Diff: ${(debits - credits).toLocaleString('sv-SE')} — debet ≠ kredit`)
      }
    }

    if (captured.period_status) {
      lines.push('')
      lines.push(
        `Period: ${captured.period_status.period_id ?? '?'} (status ${captured.period_status.status ?? '?'}${
          captured.period_status.lock_date ? `, låst t.o.m. ${captured.period_status.lock_date}` : ''
        })`,
      )
      if (captured.period_status.status === 'locked' || captured.period_status.status === 'closed') {
        lines.push('PERIODEN ÄR LÅST — vägled mot storno + ny verifikation i öppen period istället.')
      }
    }
    lines.push('')
    lines.push('Arbetssätt:')
    lines.push('1. Föreslå rätt BAS-konton baserat på beskrivningen. Syns en motpart i beskrivningen — kolla historiken med gnubok_query_journal({ text: "<motpartens namn>", limit: 5 }).')
    lines.push('2. Säkerställ att debet = kredit. Förklara varje rad kort.')
    lines.push('3. Om transaktionen i själva verket är en faktura/leverantörsfaktura/bankrad — be användaren matcha det istället. Direktbokning skapar dubbletter.')
    lines.push('4. Staga via gnubok_create_voucher när allt stämmer.')
    lines.push('')
    lines.push('Svara på svenska, kort och konkret.')
    return lines.join('\n')
  },
})
