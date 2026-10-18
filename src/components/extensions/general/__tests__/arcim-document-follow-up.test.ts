import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

import { DocumentImportFollowUp, ResultStep } from '../ArcimMigrationWorkspace'
import {
  PROVIDER_DOCUMENT_SCOPES_REQUIRED,
  PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
  type ArcimDocumentImportResult,
  type ArcimDocumentImportState,
} from '../arcim-document-import-flow'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

const noop = () => {}

function result(overrides: Partial<ArcimDocumentImportResult> = {}): ArcimDocumentImportResult {
  return {
    provider: 'fortnox',
    scanned: 214,
    linked: 0,
    skipped: 0,
    unmatched: 0,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    dryRun: true,
    unmatchedSamples: [],
    total: 214,
    partial: false,
    nextCursor: null,
    unreachableSources: [],
    ...overrides,
  }
}

function state(overrides: Partial<ArcimDocumentImportState>): ArcimDocumentImportState {
  return { phase: 'hidden', provider: 'fortnox', found: 0, result: null, problem: null, ...overrides }
}

const SUPPLIER_FILES_REFUSED = [
  {
    source: 'supplier_invoice_files' as const,
    scope: 'supplierinvoice' as const,
    reason: 'permission' as const,
    providerMessage: 'Har inte behörighet för scope (2000663)',
  },
]

function wrap(child: ReturnType<typeof createElement>, locale: 'sv' | 'en'): string {
  return renderToString(
    createElement(IntlProvider, { locale, messages: locale === 'en' ? en : sv, timeZone: 'Europe/Stockholm' }, child),
  )
}

function render(s: ArcimDocumentImportState, opts: { standalone?: boolean; locale?: 'sv' | 'en' } = {}): string {
  return wrap(
    createElement(DocumentImportFollowUp, {
      state: s,
      standalone: opts.standalone ?? true,
      onDiscover: noop,
      onImport: noop,
      onDismiss: noop,
      onReconnect: noop,
    }),
    opts.locale ?? 'sv',
  )
}

function renderPage(s: ArcimDocumentImportState): string {
  return wrap(
    createElement(ResultStep, {
      provider: 'fortnox',
      results: null,
      sieResults: [],
      omittedYears: [],
      error: null,
      documentImportState: s,
      documentsOnly: true,
      theaterModel: null,
      review: null,
      onDone: noop,
      onRetry: noop,
      onDiscoverDocuments: noop,
      onImportDocuments: noop,
      onDismissDocuments: noop,
      onReconnectDocuments: noop,
    }),
    'sv',
  )
}

const ext = sv.extensions

/** Every state the panel can show, each with the detail that used to turn it red. */
const STATES: Record<string, ArcimDocumentImportState> = {
  discovering: state({ phase: 'discovering' }),
  offered: state({
    phase: 'offered',
    found: 214,
    result: result({ locked: 37, lockedPeriods: ['2023', '2024'], unreachableSources: SUPPLIER_FILES_REFUSED }),
  }),
  importing: state({ phase: 'importing', found: 214, result: result({ scanned: 120, linked: 96, dryRun: false }) }),
  reconnecting: state({ phase: 'reconnecting', found: 214 }),
  empty: state({ phase: 'empty', result: result({ scanned: 0, total: 0, unreachableSources: SUPPLIER_FILES_REFUSED }) }),
  scopeRequired: state({
    phase: 'discovery-error',
    problem: { code: PROVIDER_DOCUMENT_SCOPES_REQUIRED, requestId: 'req_scope', reconnectRequired: true },
  }),
  scopeUnavailable: state({
    phase: 'discovery-error',
    problem: { code: PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE, requestId: null, reconnectRequired: false },
  }),
  completeWithExceptions: state({
    phase: 'complete',
    found: 214,
    result: result({
      linked: 151,
      skipped: 12,
      unmatched: 9,
      locked: 37,
      lockedPeriods: ['2023', '2024'],
      dryRun: false,
      unreachableSources: SUPPLIER_FILES_REFUSED,
    }),
  }),
  discoveryError: state({
    phase: 'discovery-error',
    problem: { code: 'PROVIDER_REQUEST_FAILED', requestId: 'req_7f3k', reconnectRequired: false, providerMessage: 'Internal server error (2000311)' },
  }),
  importError: state({ phase: 'import-error', found: 214, problem: { code: null, requestId: 'req_9a8b', reconnectRequired: false } }),
  completeWithFailures: state({
    phase: 'complete',
    found: 214,
    result: result({ linked: 151, failed: 5, dryRun: false }),
  }),
}

describe('DocumentImportFollowUp, the failure colour', () => {
  const notFailures = [
    'discovering',
    'offered',
    'importing',
    'reconnecting',
    'empty',
    'scopeRequired',
    'scopeUnavailable',
    'completeWithExceptions',
  ]

  it.each(notFailures)('never paints %s in the failure colour', (name) => {
    expect(render(STATES[name]!)).not.toContain('text-destructive')
  })

  it.each(['discoveryError', 'importError', 'completeWithFailures'])(
    'marks the real failure %s once, not the whole sentence',
    (name) => {
      expect(render(STATES[name]!).match(/text-destructive/g)).toHaveLength(1)
    },
  )
})

describe('DocumentImportFollowUp, technical detail', () => {
  it('keeps the request id and the source answer behind a disclosure', () => {
    const html = render(STATES.discoveryError!)
    const details = html.slice(html.indexOf('<details'), html.indexOf('</details>'))
    expect(details).toContain('req_7f3k')
    expect(details).toContain('Internal server error (2000311)')
    expect(html.indexOf('req_7f3k')).toBeGreaterThan(html.indexOf('<details'))
  })

  it('names Fortnox permissions as Fortnox shows them, never by API scope', () => {
    for (const name of ['offered', 'completeWithExceptions', 'empty']) {
      const html = render(STATES[name]!)
      expect(html).toContain(ext.ext_arcim_documents_scope_supplierinvoice)
      expect(html).not.toMatch(/\((?:archive|connectfile|supplierinvoice)\)/)
    }
  })

  it('tells the user to fetch documents again after fixing the permission, not to rerun the sync', () => {
    const html = render(STATES.offered!)
    expect(html).not.toContain('synken')
    expect(html).toContain(ext.ext_arcim_documents_supplier_files_how)
  })
})

describe('DocumentImportFollowUp, one way forward per state', () => {
  it('offers the import with its count, and "not now" only after a migration', () => {
    const standalone = render(STATES.offered!)
    expect(standalone).toContain('Hämta 214 underlag')
    expect(standalone).not.toContain(ext.ext_arcim_documents_not_now)

    const tail = render(STATES.offered!, { standalone: false })
    expect(tail).toContain(ext.ext_arcim_documents_not_now)
    // After a migration the offer says the files can come later without a re-run.
    expect(tail).toContain(ext.ext_arcim_documents_prompt_later.replace(/"/g, '&quot;'))
  })

  it('asks for the Fortnox approval with one button and no error wording', () => {
    const html = render(STATES.scopeRequired!)
    expect(html).toContain(ext.ext_arcim_documents_reconnect_action)
    expect(html).toContain('Fortnox behöver ditt godkännande')
    expect(html.match(/<button/g)).toHaveLength(1)
  })

  it('offers no retry while Fortnox has not opened file access, only the file upload', () => {
    const html = render(STATES.scopeUnavailable!)
    expect(html).not.toContain('<button')
    expect(html).toContain('href="/import?mode=underlag"')
  })

  it('points an empty result at the file upload', () => {
    expect(render(STATES.empty!)).toContain('href="/import?mode=underlag"')
  })

  it('leads a finished import with what landed and lists only the counts above zero', () => {
    const html = render(state({ phase: 'complete', found: 214, result: result({ linked: 181, skipped: 33, dryRun: false }) }))
    expect(html).toContain('181 underlag ligger nu på verifikaten.')
    expect(html).toContain('33 fanns redan och hoppades över.')
    expect(html).not.toContain(ext.ext_arcim_documents_failed)
    expect(html).not.toContain(ext.ext_arcim_documents_unmatched)
    expect(html).not.toContain('<button')
  })

  it('gives failed documents their own retry', () => {
    const html = render(STATES.completeWithFailures!)
    expect(html).toContain(ext.ext_arcim_documents_failed)
    expect(html).toContain(ext.ext_arcim_documents_retry_import)
  })

  it('shows the running counts while importing', () => {
    const html = render(STATES.importing!)
    expect(html).toContain('120 av 214')
    expect(html).toContain('96 kopplade hittills.')
  })
})

/** The note about supplier-invoice files, as its own `<li>`, so its action is counted alone. */
function supplierFilesNote(html: string, sentence: string): string {
  const at = html.indexOf(sentence)
  expect(at).toBeGreaterThan(-1)
  return html.slice(html.lastIndexOf('<li', at), html.indexOf('</li>', at) + '</li>'.length)
}

describe('the supplier-invoice files note', () => {
  const permissionSentence = ext.ext_arcim_documents_supplier_files_permission.replace(
    '{scope}',
    ext.ext_arcim_documents_scope_supplierinvoice,
  )

  it.each(['offered', 'empty', 'completeWithExceptions'])(
    'gives a missing Fortnox permission one way forward in %s: the reconnect the approval state uses',
    (name) => {
      const note = supplierFilesNote(render(STATES[name]!), permissionSentence)
      expect(note.match(/<button/g)).toHaveLength(1)
      expect(note).toContain(ext.ext_arcim_documents_reconnect_action)
      // Neutral: an outline button and muted text, never the failure colour
      // or a second primary next to the state's own action.
      expect(note).toContain('border-input')
      expect(note).not.toContain('bg-primary')
      expect(note).not.toContain('text-destructive')
      // Named as Fortnox shows it, never by API scope id.
      expect(note).not.toMatch(/\b(?:archive|connectfile|supplierinvoice)\b/)
    },
  )

  it('says the panel looks again after the reconnect, instead of sending the user back to fetch', () => {
    const note = supplierFilesNote(render(STATES.offered!), permissionSentence)
    expect(note).toContain('Sedan letar vi igen direkt.')
    expect(note).not.toContain('Hämta sedan underlag igen')
  })

  it('offers one reconnect when Fortnox refused two permissions', () => {
    const html = render(
      state({
        phase: 'complete',
        found: 214,
        result: result({
          linked: 151,
          dryRun: false,
          unreachableSources: [
            { source: 'supplier_invoice_files', scope: 'connectfile', reason: 'permission', providerMessage: null },
            ...SUPPLIER_FILES_REFUSED,
          ],
        }),
      }),
    )
    expect(html.split(ext.ext_arcim_documents_reconnect_action)).toHaveLength(2)
  })

  it.each(['license', 'error'] as const)('offers no reconnect for a %s note: a new login cannot change it', (reason) => {
    const html = render(
      state({
        phase: 'complete',
        found: 214,
        result: result({
          linked: 151,
          dryRun: false,
          unreachableSources: [{ ...SUPPLIER_FILES_REFUSED[0]!, reason }],
        }),
      }),
    )
    expect(html).not.toContain(ext.ext_arcim_documents_reconnect_action)
    expect(html).not.toContain('<button')
  })

  it('renders the note and its action in English with no missing key', () => {
    const html = render(STATES.completeWithExceptions!, { locale: 'en' })
    const note = supplierFilesNote(
      html,
      en.extensions.ext_arcim_documents_supplier_files_permission.replace(
        '{scope}',
        en.extensions.ext_arcim_documents_scope_supplierinvoice,
      ),
    )
    expect(note).toContain(en.extensions.ext_arcim_documents_reconnect_action)
    expect(note).toContain('Then we look again right away.')
    expect(note).not.toContain('ext_arcim_')
  })
})

describe('the standalone documents page', () => {
  it('offers the way on to the vouchers only once the import is done', () => {
    expect(renderPage(STATES.completeWithExceptions!)).toContain(ext.ext_arcim_documents_view_entries)
    for (const name of ['offered', 'importing', 'discoveryError']) {
      expect(renderPage(STATES[name]!)).not.toContain(ext.ext_arcim_documents_view_entries)
    }
  })

  it('promises the bookkeeping stays as it is, with one title', () => {
    const html = renderPage(STATES.offered!)
    expect(html).toContain('Bokföringen ändras inte.')
    expect(html.match(/Underlag från Fortnox/g)).toHaveLength(1)
  })
})

describe('DocumentImportFollowUp in English', () => {
  it.each(Object.keys(STATES))('renders %s without a missing key', (name) => {
    const html = render(STATES[name]!, { locale: 'en' })
    expect(html).not.toContain('ext_arcim_')
    expect(html).not.toMatch(/Hämta|Underlag|Försök/)
  })
})
