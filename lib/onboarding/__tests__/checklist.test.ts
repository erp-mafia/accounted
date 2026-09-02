import { describe, expect, it } from 'vitest'
import {
  checklistNumbers,
  claudeConnectorLink,
  claudeStepDone,
  completionPatchBody,
  vatDeadlineLine,
} from '../checklist'

describe('vatDeadlineLine', () => {
  it('returns null when the company is not VAT-registered', () => {
    expect(
      vatDeadlineLine({ vatRegistered: false, momsPeriod: 'quarterly', nextVatDueDate: '2026-11-12' })
    ).toBeNull()
    expect(
      vatDeadlineLine({ vatRegistered: null, momsPeriod: null, nextVatDueDate: null })
    ).toBeNull()
  })

  it('flags the silent zero-deadline misconfiguration when moms_period is unset', () => {
    expect(
      vatDeadlineLine({ vatRegistered: true, momsPeriod: null, nextVatDueDate: null })
    ).toEqual({ kind: 'missing_period' })
    // Even with a stray row, an unset period is still a misconfiguration to surface.
    expect(
      vatDeadlineLine({ vatRegistered: true, momsPeriod: undefined, nextVatDueDate: '2026-11-12' })
    ).toEqual({ kind: 'missing_period' })
  })

  it('returns the due date when registered with a period and an upcoming row', () => {
    expect(
      vatDeadlineLine({ vatRegistered: true, momsPeriod: 'quarterly', nextVatDueDate: '2026-11-12' })
    ).toEqual({ kind: 'date', dueDate: '2026-11-12' })
  })

  it('says nothing when a period is set but no upcoming row surfaced', () => {
    expect(
      vatDeadlineLine({ vatRegistered: true, momsPeriod: 'yearly', nextVatDueDate: null })
    ).toBeNull()
  })
})

describe('checklistNumbers', () => {
  it('numbers all five steps when both extensions are on', () => {
    expect(checklistNumbers({ hasSkatteverket: true, hasInbox: true })).toEqual({
      count: 5,
      skv: 3,
      receipts: 4,
      assistant: 5,
    })
  })

  it('collapses to four steps without the inbox extension', () => {
    expect(checklistNumbers({ hasSkatteverket: true, hasInbox: false })).toEqual({
      count: 4,
      skv: 3,
      receipts: 4,
      assistant: 4,
    })
  })

  it('collapses to four steps without the skatteverket extension', () => {
    expect(checklistNumbers({ hasSkatteverket: false, hasInbox: true })).toEqual({
      count: 4,
      skv: 3,
      receipts: 3,
      assistant: 4,
    })
  })

  it('collapses to three steps with neither extension', () => {
    expect(checklistNumbers({ hasSkatteverket: false, hasInbox: false })).toEqual({
      count: 3,
      skv: 3,
      receipts: 3,
      assistant: 3,
    })
  })
})

describe('completionPatchBody', () => {
  it('keeps a recorded path out of the body', () => {
    expect(completionPatchBody('bank')).toEqual({ completed: true })
    expect(completionPatchBody('fresh')).toEqual({ completed: true })
  })

  it('records migration when no path was chosen, so the route accepts completion', () => {
    // Skipped the books question, then imported: step 1 is only done via an
    // import in that state. Without a path the route answers 400 and the
    // completion effect used to retry it forever.
    expect(completionPatchBody(null)).toEqual({ completed: true, path: 'migration' })
  })
})

describe('claudeStepDone', () => {
  it('is done once an OAuth-minted MCP key row exists', () => {
    expect(claudeStepDone({ oauthKeyCount: 1 })).toBe(true)
    expect(claudeStepDone({ oauthKeyCount: 3 })).toBe(true)
  })

  it('stays open without a key row, including a null head count', () => {
    expect(claudeStepDone({ oauthKeyCount: 0 })).toBe(false)
    expect(claudeStepDone({ oauthKeyCount: null })).toBe(false)
    expect(claudeStepDone({ oauthKeyCount: undefined })).toBe(false)
  })
})

describe('claudeConnectorLink', () => {
  it('builds the claude.ai deep link with namespace, client marker and eager-auth flag, from the page origin', () => {
    const link = claudeConnectorLink({ origin: 'https://app.testbrand.example', appName: 'Testbrand' })
    expect(link).toBe(
      'https://claude.ai/customize/connectors?modal=add-custom-connector' +
        '&connectorName=Testbrand' +
        '&connectorUrl=https%3A%2F%2Fapp.testbrand.example%2Fapi%2Fextensions%2Fext%2Fmcp-server%2Fmcp%3Ftool_namespace%3Daccounted%26client%3Dclaude-connector%26auth%3Drequired',
    )
  })

  it('matches the Settings → API & MCP button shape (tool_namespace + client=claude-connector + auth=required)', () => {
    const link = claudeConnectorLink({ origin: 'http://localhost:3000', appName: 'Bokföring AB' })
    const url = new URL(link)
    expect(url.searchParams.get('connectorName')).toBe('Bokföring AB')
    const server = new URL(url.searchParams.get('connectorUrl') ?? '')
    expect(server.origin).toBe('http://localhost:3000')
    expect(server.pathname).toBe('/api/extensions/ext/mcp-server/mcp')
    expect(server.searchParams.get('tool_namespace')).toBe('accounted')
    expect(server.searchParams.get('client')).toBe('claude-connector')
    // Without this flag claude.ai's Add-custom-connector dialog pre-fills
    // Authentication "None" (the lazy handshake answers 200) and the sign-in
    // never opens.
    expect(server.searchParams.get('auth')).toBe('required')
  })
})
