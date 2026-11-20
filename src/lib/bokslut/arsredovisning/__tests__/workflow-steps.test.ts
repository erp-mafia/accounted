import { describe, it, expect } from 'vitest'
import {
  ANNUAL_REPORT_NEXT_ACTIONS,
  ANNUAL_REPORT_STEP_KEYS,
  deriveAnnualReportWorkflow,
  isAgmRecorded,
  stepForIssue,
  type AnnualReportWorkflowInput,
} from '../workflow-steps'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { AnnualReportComplianceIssue, AnnualReportVersionSummary } from '../compliance-types'

type Issue = Pick<AnnualReportComplianceIssue, 'code' | 'severity' | 'section'>
type Version = Pick<AnnualReportVersionSummary, 'id' | 'version_number' | 'status'>

function issue(code: string, section: Issue['section'], severity: Issue['severity'] = 'error'): Issue {
  return { code, section, severity }
}

/** Everything up to the lock is in place; nothing is locked yet. */
function readyToLock(overrides: Partial<AnnualReportWorkflowInput> = {}): AnnualReportWorkflowInput {
  return {
    yearClosed: true,
    issues: [],
    signerRosterConfirmed: true,
    unsavedContent: false,
    unsavedAgm: false,
    signers: [{ status: 'pending', annual_report_version_id: null }],
    versions: [],
    agmRecorded: false,
    ...overrides,
  }
}

function stateOf(input: AnnualReportWorkflowInput) {
  const workflow = deriveAnnualReportWorkflow(input)
  return {
    workflow,
    states: Object.fromEntries(workflow.steps.map((step) => [step.key, step.state])),
    details: Object.fromEntries(workflow.steps.map((step) => [step.key, step.detail])),
  }
}

describe('deriveAnnualReportWorkflow', () => {
  it('lists the eight steps in the order the law runs them', () => {
    const { workflow } = stateOf(readyToLock())
    expect(workflow.steps.map((step) => step.key)).toEqual([
      'bokslut',
      'scope',
      'content',
      'board',
      'lock',
      'signatures',
      'agm',
      'filing',
    ])
  })

  it('marks exactly one step as current, the one the next action belongs to', () => {
    const { workflow } = stateOf(readyToLock())
    const current = workflow.steps.filter((step) => step.state === 'current')
    expect(current).toHaveLength(1)
    expect(current[0].key).toBe(workflow.next?.step)
  })

  it('starts with the bokslut when the year is still open', () => {
    const { workflow, states } = stateOf(
      readyToLock({
        yearClosed: false,
        issues: [issue('AR-K2-ASSESSMENT-UNCONFIRMED', 'scope')],
        signers: [],
        signerRosterConfirmed: false,
      }),
    )
    expect(workflow.next).toEqual({ step: 'bokslut', action: 'close_year' })
    expect(states.bokslut).toBe('current')
    expect(states.scope).toBe('upcoming')
  })

  it('asks to save the scope assessment while a scope question is open', () => {
    const { workflow, details } = stateOf(
      readyToLock({
        issues: [issue('AR-K2-ASSESSMENT-UNCONFIRMED', 'scope'), issue('AR-COMPANY-ORGNR', 'company')],
      }),
    )
    expect(workflow.next).toEqual({ step: 'scope', action: 'save_scope' })
    expect(details.scope).toEqual({ kind: 'errors', count: 2 })
  })

  it('points to the company settings when only company data is missing', () => {
    const { workflow } = stateOf(
      readyToLock({ issues: [issue('AR-COMPANY-REGISTERED-OFFICE', 'company')] }),
    )
    expect(workflow.next).toEqual({ step: 'scope', action: 'fix_company' })
  })

  it('ignores warnings and info issues', () => {
    const { workflow, states } = stateOf(
      readyToLock({
        issues: [
          issue('AR-SOURCE-WARNING', 'statements', 'warning'),
          issue('AR-SOMETHING', 'scope', 'info'),
        ],
      }),
    )
    expect(states.scope).toBe('done')
    expect(states.content).toBe('done')
    expect(workflow.next).toEqual({ step: 'lock', action: 'lock_version' })
  })

  it('asks to fix the content before it can be confirmed', () => {
    const { workflow, details } = stateOf(
      readyToLock({
        issues: [
          issue('AR-MANAGEMENT-UNCONFIRMED', 'management_report'),
          issue('AR-NOTE-SECURITIES-UNCONFIRMED', 'notes'),
        ],
      }),
    )
    expect(workflow.next).toEqual({ step: 'content', action: 'fix_content' })
    expect(details.content).toEqual({ kind: 'errors', count: 2 })
  })

  it('asks to confirm the content when that is all that is left', () => {
    const { workflow } = stateOf(
      readyToLock({ issues: [issue('AR-MANAGEMENT-UNCONFIRMED', 'management_report')] }),
    )
    expect(workflow.next).toEqual({ step: 'content', action: 'confirm_content' })
  })

  it('puts unsaved text first, ahead of an open bokslut', () => {
    const { workflow, states, details } = stateOf(readyToLock({ yearClosed: false, unsavedContent: true }))
    expect(workflow.next).toEqual({ step: 'content', action: 'save_text' })
    expect(states.content).toBe('current')
    expect(states.bokslut).toBe('upcoming')
    expect(details.content).toEqual({ kind: 'unsaved' })
  })

  it('asks for the board and VD when no signer is registered', () => {
    const { workflow } = stateOf(readyToLock({ signers: [], signerRosterConfirmed: false }))
    expect(workflow.next).toEqual({ step: 'board', action: 'add_signer' })
  })

  it('does not count a declined signer as registered', () => {
    const { workflow } = stateOf(
      readyToLock({ signers: [{ status: 'declined', annual_report_version_id: null }] }),
    )
    expect(workflow.next).toEqual({ step: 'board', action: 'add_signer' })
  })

  it('asks to confirm the roster once signers exist', () => {
    const { workflow } = stateOf(readyToLock({ signerRosterConfirmed: false }))
    expect(workflow.next).toEqual({ step: 'board', action: 'confirm_roster' })
  })

  it('offers the lock once everything before it is in place, noting a draft copy', () => {
    const { workflow, details } = stateOf(
      readyToLock({
        versions: [
          { id: 'v2', version_number: 2, status: 'draft' },
          { id: 'v1', version_number: 1, status: 'draft' },
        ],
      }),
    )
    expect(workflow.next).toEqual({ step: 'lock', action: 'lock_version' })
    expect(details.lock).toEqual({ kind: 'draft', number: 2 })
  })

  it('stops a K3 report at the lock, without blaming the scope step', () => {
    const { workflow, states, details } = stateOf(
      readyToLock({ issues: [issue('AR-K3-DRAFT-ONLY', 'scope')] }),
    )
    expect(states.scope).toBe('done')
    expect(workflow.next).toEqual({ step: 'lock', action: 'k3_draft_only' })
    expect(details.lock).toEqual({ kind: 'k3_draft_only' })
  })

  it('reports blockers that belong to no earlier step on the lock', () => {
    const { workflow, details } = stateOf(readyToLock({ issues: [issue('AR-AGM-DATE', 'agm')] }))
    expect(workflow.next).toEqual({ step: 'lock', action: 'fix_blockers' })
    expect(details.lock).toEqual({ kind: 'errors', count: 1 })
  })

  it('keeps signing-stage signer issues on the board step after a refused lock', () => {
    expect(stepForIssue({ code: 'AR-SIGNER-ROSTER-UNCONFIRMED', section: 'signatures' })).toBe('board')
    const { workflow } = stateOf(
      readyToLock({
        signerRosterConfirmed: false,
        issues: [issue('AR-SIGNER-ROSTER-UNCONFIRMED', 'signatures')],
      }),
    )
    expect(workflow.next).toEqual({ step: 'board', action: 'confirm_roster' })
  })

  describe('after the lock', () => {
    const locked: Version[] = [
      { id: 'v3', version_number: 3, status: 'ready_for_signature' },
      { id: 'v2', version_number: 2, status: 'superseded' },
      { id: 'v1', version_number: 1, status: 'draft' },
    ]

    it('treats scope, content and board as frozen in the locked version', () => {
      // Saving the AGM date clears the live content confirmation; the
      // locked version is unaffected and the steps stay done.
      const { workflow, states, details } = stateOf(
        readyToLock({
          versions: locked,
          signerRosterConfirmed: false,
          issues: [issue('AR-MANAGEMENT-UNCONFIRMED', 'management_report')],
          signers: [
            { status: 'signed', annual_report_version_id: 'v3' },
            { status: 'pending', annual_report_version_id: 'v3' },
          ],
        }),
      )
      expect(states.scope).toBe('done')
      expect(states.content).toBe('done')
      expect(states.board).toBe('done')
      expect(states.lock).toBe('done')
      expect(details.lock).toEqual({ kind: 'version', number: 3 })
      expect(workflow.next).toEqual({ step: 'signatures', action: 'register_signatures' })
      expect(details.signatures).toEqual({ kind: 'progress', done: 1, total: 2 })
    })

    it('ignores a superseded version when finding the one to sign', () => {
      const { workflow } = stateOf(
        readyToLock({
          versions: [
            { id: 'v2', version_number: 2, status: 'superseded' },
            { id: 'v1', version_number: 1, status: 'draft' },
          ],
        }),
      )
      expect(workflow.next).toEqual({ step: 'lock', action: 'lock_version' })
    })

    it('still points to an open bokslut when a version was locked before closing', () => {
      const { workflow } = stateOf(readyToLock({ yearClosed: false, versions: locked }))
      expect(workflow.next).toEqual({ step: 'bokslut', action: 'close_year' })
    })

    it('moves on to the AGM once the version is signed', () => {
      const { workflow } = stateOf(
        readyToLock({ versions: [{ id: 'v3', version_number: 3, status: 'signed' }] }),
      )
      expect(workflow.next).toEqual({ step: 'agm', action: 'record_agm' })
    })

    it('puts unsaved AGM fields first', () => {
      const { workflow, details } = stateOf(
        readyToLock({ unsavedAgm: true, versions: [{ id: 'v3', version_number: 3, status: 'ready_for_signature' }] }),
      )
      expect(workflow.next).toEqual({ step: 'agm', action: 'save_agm' })
      expect(details.agm).toEqual({ kind: 'unsaved' })
    })

    it('leaves the filing as the last step until Bolagsverket has the report', () => {
      const { workflow } = stateOf(
        readyToLock({ agmRecorded: true, versions: [{ id: 'v3', version_number: 3, status: 'signed' }] }),
      )
      expect(workflow.next).toEqual({ step: 'filing', action: 'file' })
    })

    it('is done when the signed version is filed', () => {
      const { workflow } = stateOf(
        readyToLock({ agmRecorded: true, versions: [{ id: 'v3', version_number: 3, status: 'registered' }] }),
      )
      expect(workflow.next).toBeNull()
      expect(workflow.steps.every((step) => step.state === 'done')).toBe(true)
    })
  })
})

describe('isAgmRecorded', () => {
  it('needs both the date and the decision', () => {
    expect(
      isAgmRecorded({ agm_date: '2026-05-20', agm_disposition_outcome: null, agm_disposition_decision: null }),
    ).toBe(false)
    expect(
      isAgmRecorded({ agm_date: null, agm_disposition_outcome: 'proposal_approved', agm_disposition_decision: null }),
    ).toBe(false)
    expect(
      isAgmRecorded({
        agm_date: '2026-05-20',
        agm_disposition_outcome: 'proposal_approved',
        agm_disposition_decision: null,
      }),
    ).toBe(true)
  })

  it('needs the text of an alternative decision', () => {
    expect(
      isAgmRecorded({
        agm_date: '2026-05-20',
        agm_disposition_outcome: 'alternative_decision',
        agm_disposition_decision: '  ',
      }),
    ).toBe(false)
    expect(
      isAgmRecorded({
        agm_date: '2026-05-20',
        agm_disposition_outcome: 'alternative_decision',
        agm_disposition_decision: 'Hela resultatet balanseras i ny räkning.',
      }),
    ).toBe(true)
  })
})

describe('annualReportSteps strings', () => {
  // The page builds these keys from the step and action names.
  it.each([
    ['sv', sv.annualReportSteps],
    ['en', en.annualReportSteps],
  ])('%s has a label for every step and a sentence for every next action', (_locale, messages) => {
    const keys = Object.keys(messages)
    for (const step of ANNUAL_REPORT_STEP_KEYS) expect(keys).toContain(`step_${step}`)
    for (const action of ANNUAL_REPORT_NEXT_ACTIONS) expect(keys).toContain(`next_${action}`)
  })

  it('carries no em or en dashes', () => {
    const text = JSON.stringify([sv.annualReportSteps, en.annualReportSteps])
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })
})
