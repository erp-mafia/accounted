import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentIntent } from '@/lib/agent/intents/types'
import { buildIdentityBlock } from '../system-prompt'

// buildIdentityBlock is the always-on Block 2 of the chat system prompt. Unlike
// the per-intent ground rules (which sit only in the first user message and
// fall out of salience deep in a conversation), this block is re-sent on every
// turn. These guards lock in the epistemics rules added after the agent
// confidently answered "matvaror är 12 %" from stale training memory: it
// dropped to 6 % in April 2026, and invented a "ränteintäkter från ALMI"
// concern by inferring a lending business from an SNI code.

type VatStatus = Parameters<typeof buildIdentityBlock>[0]['vatStatus']

// Minimal base-typed intent: buildIdentityBlock only reads id, sheetTitle and
// atoms.mode. (The concrete intents have narrow capture/template generics that
// don't unify with the base AgentIntent the builder expects; the real call site
// resolves intents through the registry as base-typed.)
const intent: AgentIntent = {
  id: 'general.help',
  buttonLabel: 'x',
  sheetTitle: 'Fråga din assistent',
  atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
  tools: [],
  model: 'claude-sonnet-4-6',
  capture: async () => ({}),
  promptTemplate: () => '',
}

function block(vatStatus: VatStatus): string {
  return buildIdentityBlock({
    intent,
    companyId: 'c1',
    companyName: 'Testbolaget AB',
    firstName: 'Jakob',
    profileSummary: null,
    rankedMemory: [],
    vatStatus,
    today: '2026-01-01 (torsdag)',
    // buildIdentityBlock never touches supabase; it's a pure render of args.
    supabase: {} as unknown as SupabaseClient,
  })
}

const VAT_STATES: VatStatus[] = [
  null,
  { vat_registered: true, vat_number: 'SE556677889901' },
  { vat_registered: false, vat_number: null },
]

describe('chat system prompt: always-on epistemics rules', () => {
  it('forces load-before-answer for regulatory figures, on every VAT status', () => {
    for (const vs of VAT_STATES) {
      const out = block(vs)
      expect(out).toContain('# Säkerhet i sak: ladda reglerna, gissa aldrig från minnet')
      // Must point at the load tool and demand reading before answering.
      expect(out).toContain('gnubok_load_skill')
      // The canonical staleness trap must be named so the rule is concrete,
      // not abstract: a model answering food VAT "12 %" from memory is wrong.
      expect(out).toContain('12 %→6 %')
    }
  })

  it('kills the "I am sure" escape hatch and turns "are you sure?" into a verify signal', () => {
    const out = block(null)
    expect(out).toContain('ja, jag är säker')
    expect(out).toContain('är du säker?')
    // The instruction must be to load/verify, not to repeat the prior answer.
    expect(out.toLowerCase()).toContain('upprepa')
  })

  it('forbids inferring the business from weak signals like SNI codes', () => {
    const out = block(null)
    expect(out).toContain('# Påstå inget om bolaget du inte grundat i data')
    expect(out).toContain('SNI-kod')
    // Resolve real uncertainty by reading data or asking: not by speculating.
    expect(out).toMatch(/läsverktyg|fråga/i)
  })

  it('anchors relative-time reasoning to the supplied current date', () => {
    // Without an explicit "today" the model dates "förra månaden" / overdue
    // invoices / the current VAT period off its training cutoff. The date the
    // caller passes must land verbatim in the always-on block.
    const out = block(null)
    expect(out).toContain('# Dagens datum')
    expect(out).toContain('Idag är 2026-01-01 (torsdag).')
    // Must tell the model to trust this over its own sense of "now".
    expect(out).toContain('träningsdata')
  })

  it('addresses the user by their own tilltalsnamn, not owner/signatory names from the profile', () => {
    // Regression: the agent answered "vad heter jag" with the registered
    // firmatecknare's legal name from "Företagets profil" instead of the
    // user's own chosen name. The role block must name the user (firstName)
    // and explicitly demote company owner/signatory names.
    const out = block(null)
    expect(out).toContain('Jakob')
    expect(out).toMatch(/tilltalsnamn/i)
    expect(out).toContain('firmatecknare')
  })

  it('lets the agent read a pre-loaded atom directly instead of re-loading it', () => {
    // Declarative intents pre-load swedish-vat etc. into Block 1, so the rule
    // must not force a redundant gnubok_load_skill when the owning atom is
    // already present. This nuance used to live only in the per-intent KÄLLOR
    // line; it now lives here, in the single canonical epistemics home.
    const out = block(null)
    expect(out).toContain('redan laddad')
  })
})
