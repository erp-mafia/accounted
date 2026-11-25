import { describe, it, expect } from 'vitest'
import { tools } from '../server'
import {
  CLIENT_INSTRUCTIONS_CUT,
  CONNECT_TRIGGER_TOOL,
  buildServerInstructionParts,
  buildServerInstructions,
  type ServerInstructionsOptions,
} from '../server-instructions'
import { projectToolReferencesInText } from '../tool-namespace'

// Claude Code cut both Accounted connectors' instructions at character 4096
// (measured 2026-11-06), dropping the approval, staging and year-end rules
// that sat after the workflow recipes. The head must survive that cut in
// every connection variant, rendered in the namespace the client sees.

const canonical = new Set(tools.map((t) => t.name))
const COMPANY_ID = 'c0000000-0000-4000-8000-0000000000a1'

type CompanyMode = Pick<ServerInstructionsOptions, 'pinnedCompanyId' | 'pinnedCompanyName' | 'simpleCompanyMode' | 'companyId'>

const COMPANY_MODES: Record<string, CompanyMode> = {
  pinned: {
    pinnedCompanyId: COMPANY_ID,
    // A long legal name: the pin line is the one head line that grows with data.
    pinnedCompanyName: 'Exempelbolaget Redovisning och Konsultverksamhet i Norrland AB',
    simpleCompanyMode: false,
    companyId: COMPANY_ID,
  },
  'simple, one company': { pinnedCompanyId: null, pinnedCompanyName: null, simpleCompanyMode: true, companyId: COMPANY_ID },
  'simple, no company': { pinnedCompanyId: null, pinnedCompanyName: null, simpleCompanyMode: true, companyId: null },
  'multi, default company': { pinnedCompanyId: null, pinnedCompanyName: null, simpleCompanyMode: false, companyId: COMPANY_ID },
  'multi, no company': { pinnedCompanyId: null, pinnedCompanyName: null, simpleCompanyMode: false, companyId: null },
}

const variants: Array<[string, ServerInstructionsOptions]> = []
for (const toolNamespace of ['gnubok', 'accounted'] as const) {
  for (const isAnonymous of [true, false]) {
    // The approval view only changes text on a connection that can approve.
    for (const [canApprove, approvalView] of [[true, true], [true, false], [false, false]] as const) {
      for (const [mode, company] of Object.entries(COMPANY_MODES)) {
        variants.push([
          `${toolNamespace}, ${isAnonymous ? 'anonymous' : 'keyed'}, ${canApprove ? (approvalView ? 'approve + view' : 'approve') : 'no approve'}, ${mode}`,
          { toolNamespace, isAnonymous, canApprove, approvalView, ...company },
        ])
      }
    }
  }
}

function render(o: ServerInstructionsOptions) {
  const project = (text: string) => projectToolReferencesInText(text, o.toolNamespace, canonical)
  const { head, reference } = buildServerInstructionParts(o)
  return { head: project(head), reference: project(reference), full: project(buildServerInstructions(o)) }
}

describe('server instructions survive a client that cuts at 4096 characters', () => {
  it.each(variants)('%s: the head fits inside the cut', (_name, o) => {
    const { head, full } = render(o)
    expect(full.startsWith(head)).toBe(true)
    expect(head.length).toBeLessThanOrEqual(CLIENT_INSTRUCTIONS_CUT)
  })

  it.each(variants)('%s: the head carries every rule an agent must not lose', (_name, o) => {
    const { head } = render(o)
    const p = o.toolNamespace === 'accounted' ? 'accounted_' : 'gnubok_'
    expect(head).toContain('STAGE a pending_operation')
    expect(head).toContain('nothing posts until commit')
    expect(head).toContain('confirmed=true on the APPROVE call')
    expect(head).toContain(o.canApprove ? 'APPROVAL IS A FIRST-CLASS AGENT ACTION' : 'APPROVAL ON THIS CONNECTION')
    if (o.canApprove) {
      expect(head).toContain('WHO THE RECORD NAMES')
      expect(head.includes('open the widget instead of approving')).toBe(o.approvalView)
    }
    expect(head).toContain(`${p}year_end_readiness first, then ${p}run_year_end on the OPEN period`)
    expect(head).toContain(`Never ${p}lock_period or ${p}close_period before it`)
    expect(head).toContain('data_status.preliminary')
    expect(head).toContain('Account numbers are strings')
    expect(head).toContain(`${p}search_tools`)
    expect(head).toContain(`${p}list_skills`)
    expect(head).toMatch(/• Compan(y|ies):/)
    if (o.isAnonymous) expect(head).toContain('NOT CONNECTED YET')
  })

  // From the anonymous initialize alone, an integrator could not tell how to
  // start sign-in for an existing account (2026-11-18): name the call.
  it.each(variants.filter(([, o]) => o.isAnonymous))('%s: the head tells an existing user how to connect', (_name, o) => {
    const { head } = render(o)
    const trigger = projectToolReferencesInText(CONNECT_TRIGGER_TOOL, o.toolNamespace, canonical)
    expect(head).toContain('already has an Accounted account')
    expect(head).toContain(`call ${trigger} with no arguments. It returns the authentication challenge`)
    expect(head).not.toContain('this account has no company yet')
  })

  it('names a connect trigger that exists, and keeps the no-company advice for a connected account', () => {
    expect(canonical.has(CONNECT_TRIGGER_TOOL)).toBe(true)
    const keyed = render({ toolNamespace: 'gnubok', isAnonymous: false, canApprove: true, approvalView: false, ...COMPANY_MODES['multi, no company'] }).head
    expect(keyed).toContain('this account has no company yet')
    expect(keyed).not.toContain('NOT CONNECTED YET')
  })

  it('keeps discovery detail and workflow recipes after the head', () => {
    const { reference } = render(variants[0][1])
    expect(reference.startsWith('\nDiscovery:')).toBe(true)
    expect(reference).toContain('Common workflows:')
    expect(reference).toContain('A bridge your client does not show means it kept an older copy of tools/list')
  })

  it.each(variants)('%s: says how the user names a proposal, and that tools still take the id', (_name, o) => {
    const { reference } = render(o)
    const p = o.toolNamespace === 'accounted' ? 'accounted_' : 'gnubok_'
    expect(reference).toContain(`each row of ${p}list_pending_operations carry operation_number`)
    expect(reference).toContain('"Förslag 128"')
    expect(reference).toContain('tools take operation_id')
  })

  it('names only the cross-company tools on a multi-company connection', () => {
    const multi = render({ toolNamespace: 'gnubok', isAnonymous: false, canApprove: true, approvalView: false, ...COMPANY_MODES['multi, default company'] }).full
    const simple = render({ toolNamespace: 'gnubok', isAnonymous: false, canApprove: true, approvalView: false, ...COMPANY_MODES['simple, one company'] }).full
    expect(multi).toContain('gnubok_run_across_companies')
    expect(simple).not.toContain('gnubok_run_across_companies')
  })

  // A multi-company integrator checks which company a result is for; the
  // dispatcher puts it in _meta.company only when the key reaches several
  // companies (company-echo-dispatch.test.ts), so only those connections are told.
  it('tells a multi-company connection where the company of a result is', () => {
    const multi = render({ toolNamespace: 'accounted', isAnonymous: false, canApprove: true, approvalView: false, ...COMPANY_MODES['multi, default company'] }).full
    const simple = render({ toolNamespace: 'accounted', isAnonymous: false, canApprove: true, approvalView: false, ...COMPANY_MODES['simple, one company'] }).full
    const pinned = render({ toolNamespace: 'accounted', isAnonymous: false, canApprove: true, approvalView: false, ...COMPANY_MODES.pinned }).full
    expect(multi).toContain('the company it ran for in result._meta.company ({company_id, name, is_default}), also through accounted_call_tool and accounted_stage_tool')
    expect(multi).toContain('structuredContent keeps the tool\'s own outputSchema shape without it')
    expect(simple).not.toContain('_meta.company')
    expect(pinned).not.toContain('_meta.company')
  })
})
