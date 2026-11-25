import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

import { ProviderStep, offeredProviders, replacedCopyUnderlagOffer } from '../ArcimMigrationWorkspace'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

type ConnectionStatus = NonNullable<ComponentProps<typeof ProviderStep>['connectionStatus']>

const FORTNOX_CONSENT = {
  id: 'consent-1',
  provider: 'fortnox' as const,
  status: 1,
  createdAt: '2026-10-01T09:00:00Z',
}

const COMPLETED_IMPORT = {
  id: 'import-1',
  filename: 'migration-sie-2025.se',
  status: 'completed',
  accounts_count: 120,
  transactions_count: 340,
  company_name: null,
  fiscal_year_start: '2025-01-01',
  fiscal_year_end: '2025-12-31',
  imported_at: '2026-10-09T10:00:00Z',
  created_at: '2026-10-09T10:00:00Z',
}

const BOKIO_CONSENT = {
  id: 'consent-2',
  provider: 'bokio' as const,
  status: 1,
  createdAt: '2026-10-01T09:00:00Z',
}

function status(imported: boolean, consents: ConnectionStatus['consents'] = [FORTNOX_CONSENT]): ConnectionStatus {
  return {
    consents,
    sieImports: imported ? [COMPLETED_IMPORT] : [],
    hasCompletedSieImport: imported,
    latestCompletedSieImport: imported ? COMPLETED_IMPORT : null,
    unfinishedConnect: null,
    entityCounts: { customers: 0, suppliers: 0, invoices: 0 },
  }
}

function render(connectionStatus: ConnectionStatus, locale: 'sv' | 'en' = 'sv'): string {
  const step = createElement(ProviderStep, {
    onSelect: () => {},
    onResync: () => {},
    onFetchDocuments: () => {},
    onDisconnect: () => {},
    connectionStatus,
    isLoadingStatus: false,
  })
  return renderToString(
    createElement(
      IntlProvider,
      { locale, messages: locale === 'en' ? en : sv, timeZone: 'Europe/Stockholm' },
      step,
    ),
  )
}

const fetchDocuments = sv.extensions.ext_arcim_documents_fetch_action
const connectAnother = 'Anslut ytterligare system'

describe('ProviderStep, a company without a completed ledger import (crm#1118)', () => {
  it('offers to continue the import, not to sync again', () => {
    const html = render(status(false))
    expect(html).toContain(sv.extensions.ext_arcim_continue_import)
    expect(html).not.toContain(sv.extensions.ext_arcim_resync)
    // The provider list points at the same button.
    expect(html).toContain(`Använd &quot;${sv.extensions.ext_arcim_continue_import}&quot; ovan`)
  })

  it('is headed as the move to finish, not as connecting another system', () => {
    const html = render(status(false))
    expect(html).toContain(sv.extensions.ext_arcim_continue_import_heading)
    expect(html).not.toContain(connectAnother)
  })

  // Underlag link to imported verifikat by voucher number, so the import
  // cannot run yet; a hidden button left a customer looking for it, so the
  // row shows it disabled and says what comes first.
  it('shows Hämta underlag disabled and says the bookkeeping comes first', () => {
    const html = render(status(false))
    expect(html).toContain(fetchDocuments)
    const fetchButton = html.slice(html.lastIndexOf('<button', html.indexOf(fetchDocuments)), html.indexOf(fetchDocuments))
    // The attribute, not the disabled: utility classes every Button carries.
    expect(fetchButton).toMatch(/\sdisabled=""/)
    expect(fetchButton).not.toContain('bg-primary')
    expect(html).toContain(sv.extensions.ext_arcim_documents_fetch_after_ledger)
    expect(html).not.toContain(sv.extensions.ext_arcim_documents_fetch_after_sie)
  })

  it('tells a Bokio connection the bookkeeping comes as a SIE file first', () => {
    const html = render(status(false, [BOKIO_CONSENT]))
    const fetchButton = html.slice(html.lastIndexOf('<button', html.indexOf(fetchDocuments)), html.indexOf(fetchDocuments))
    expect(fetchButton).toMatch(/\sdisabled=""/)
    expect(html).toContain(sv.extensions.ext_arcim_documents_fetch_after_sie)
    expect(html).not.toContain(sv.extensions.ext_arcim_documents_fetch_after_ledger)
  })

  it('keeps Fortsätt importen as the row\'s first action', () => {
    const html = render(status(false))
    expect(html.indexOf(sv.extensions.ext_arcim_continue_import)).toBeLessThan(html.indexOf(fetchDocuments))
  })

  it('says nothing about the bookkeeping coming first once it is imported', () => {
    expect(render(status(true))).not.toContain(sv.extensions.ext_arcim_documents_fetch_after_ledger)
  })

  it('says the same in English', () => {
    const html = render(status(false), 'en')
    expect(html).toContain(en.extensions.ext_arcim_documents_fetch_action)
    expect(html).toContain(en.extensions.ext_arcim_documents_fetch_after_ledger)
  })
})

describe('ProviderStep, a company with an imported ledger', () => {
  it('keeps the re-run, the underlag import and the heading for another system', () => {
    const html = render(status(true))
    expect(html).toContain(sv.extensions.ext_arcim_resync)
    expect(html).toContain(fetchDocuments)
    expect(html).toContain(connectAnother)
    expect(html).not.toContain(sv.extensions.ext_arcim_continue_import)
    expect(html).not.toContain(sv.extensions.ext_arcim_continue_import_heading)
  })

  // Customers re-ran the whole migration to get their files (PH 185, PH 180):
  // the underlag import is the row's first, filled action, the re-run says
  // what it is, and the provider list no longer points at the re-run.
  it('leads with Hämta underlag and names the re-run for what it is', () => {
    const html = render(status(true))
    expect(sv.extensions.ext_arcim_resync).toBe('Kör migreringen igen')
    expect(html.indexOf(fetchDocuments)).toBeLessThan(html.indexOf(sv.extensions.ext_arcim_resync))
    const fetchButton = html.slice(html.lastIndexOf('<button', html.indexOf(fetchDocuments)), html.indexOf(fetchDocuments))
    expect(fetchButton).toContain('bg-primary')
    expect(html).toContain(sv.extensions.ext_arcim_connected_above)
    expect(html).not.toContain(`Använd &quot;${sv.extensions.ext_arcim_resync}&quot; ovan`)
  })
})

describe('ProviderStep, a connection the latest underlag run found refused (B11)', () => {
  const refusedRun = {
    provider: 'fortnox',
    startedAt: '2026-10-22T17:30:00Z',
    updatedAt: '2026-10-22T17:50:20Z',
    complete: false,
    total: 4610,
    scanned: 1200,
    linked: 1190,
    skipped: 5,
    unmatched: 5,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: 'file-1200',
    needsReconnect: true,
    stalled: true,
  }

  it('says the run waits for a reconnect and offers it in place of Hämta underlag', () => {
    const html = render({ ...status(true), latestDocumentImport: refusedRun })
    expect(html).toContain('Fortnox behöver kopplas igen')
    expect(html).toContain('Koppla Fortnox igen')
    expect(html).not.toContain(fetchDocuments)
  })

  it('keeps Hämta underlag once a run got through again', () => {
    const html = render({ ...status(true), latestDocumentImport: { ...refusedRun, needsReconnect: false, stalled: false } })
    expect(html).toContain(fetchDocuments)
    expect(html).not.toContain('Koppla Fortnox igen')
  })

  it('leaves another provider row alone', () => {
    const html = render({ ...status(true, [FORTNOX_CONSENT, BOKIO_CONSENT]), latestDocumentImport: refusedRun })
    expect(html).toContain('Koppla Fortnox igen')
    expect(html).toContain(fetchDocuments)
  })
})

describe('ProviderStep, a Visma or Bokio connection before the SIE upload', () => {
  it('keeps the re-run, since the ledger has to come in as a SIE file first', () => {
    const html = render(status(false, [BOKIO_CONSENT]))
    expect(html).toContain(sv.extensions.ext_arcim_resync)
    expect(html).not.toContain(sv.extensions.ext_arcim_continue_import)
    expect(html).toContain('Ladda upp SIE-fil')
    expect(html).toContain(sv.extensions.ext_arcim_connected_above)
  })

  it('labels each connection by what it can do when Fortnox and Bokio sit side by side', () => {
    const html = render(status(false, [FORTNOX_CONSENT, BOKIO_CONSENT]))
    expect(html).toContain(sv.extensions.ext_arcim_continue_import)
    expect(html).toContain(sv.extensions.ext_arcim_resync)
  })
})

describe('ProviderStep in English', () => {
  it('names the connection action and points at the row in the same language, imported or not', () => {
    const continuing = render(status(false), 'en')
    expect(continuing).toContain(`Use &quot;${en.extensions.ext_arcim_continue_import}&quot; above`)

    const imported = render(status(true), 'en')
    expect(imported).toContain(en.extensions.ext_arcim_resync)
    expect(imported).toContain(en.extensions.ext_arcim_connected_above)
    expect(imported).not.toContain(sv.extensions.ext_arcim_resync)
  })
})

describe('ProviderStep, the provider cards', () => {
  const ALL = ['fortnox', 'visma', 'bokio', 'bjornlunden', 'briox', 'wint'] as const

  it('shows no WINT card when the server leaves WINT out', () => {
    const html = render({ ...status(true, []), enabledProviders: ['fortnox', 'visma', 'bokio', 'bjornlunden', 'briox'] })
    expect(html).not.toContain('/logos/wint.png')
    expect(html).toContain('/logos/fortnox.svg')
  })

  it('shows the WINT card once the server names it', () => {
    const html = render({ ...status(true, []), enabledProviders: [...ALL] })
    expect(html).toContain('/logos/wint.png')
  })

  it('keeps WINT hidden for a server that does not say which providers it can connect', () => {
    expect(offeredProviders(null).map((p) => p.id)).not.toContain('wint')
    expect(offeredProviders({}).map((p) => p.id)).toEqual(['fortnox', 'visma', 'bokio', 'bjornlunden', 'briox'])
  })
})

// crm#1476 / PH 219: "is the Bokio key still used after the migration, and can
// Accounted change anything in Bokio with it?" The row answers both.
describe('ProviderStep, what the stored key is still for', () => {
  const idle = { ...BOKIO_CONSENT, keyUse: 'idle' as const }
  const idleLine = sv.extensions.ext_arcim_key_idle.replaceAll('{provider}', 'Bokio')
  const removeKey = sv.extensions.ext_arcim_key_remove

  it('says a finished migration no longer uses the key, that Accounted only reads, and offers to remove it', () => {
    const html = render(status(true, [idle]))
    expect(html).toContain(idleLine)
    expect(idleLine).toContain('läser bara')
    expect(html).toContain(removeKey)
    // One way out per row: the named button replaces the bare icon.
    expect(html).not.toContain('aria-label="Koppla från Bokio"')
  })

  it('says the key still fetches missing invoice rows, and keeps only the icon', () => {
    const html = render(status(true, [{ ...BOKIO_CONSENT, keyUse: 'invoice_rows' }]))
    expect(html).toContain(sv.extensions.ext_arcim_key_in_use_rows.replaceAll('{provider}', 'Bokio'))
    expect(html).not.toContain(removeKey)
    expect(html).toContain('aria-label="Koppla från Bokio"')
  })

  it('says nothing about the key while the migration runs or when the server did not tell', () => {
    for (const consent of [{ ...BOKIO_CONSENT, keyUse: 'migration' as const }, BOKIO_CONSENT]) {
      const html = render(status(true, [consent]))
      expect(html).not.toContain(idleLine)
      expect(html).not.toContain(removeKey)
      expect(html).toContain('aria-label="Koppla från Bokio"')
    }
  })

  it('names the key and the button in English', () => {
    const html = render(status(true, [idle]), 'en')
    expect(html).toContain(en.extensions.ext_arcim_key_idle.replaceAll('{provider}', 'Bokio'))
    expect(html).toContain(en.extensions.ext_arcim_key_remove)
  })
})

// #51: an earlier "Hämta underlag" put the files on the first copy of each
// verifikat, and a re-run migration then reversed that copy, so the live
// verifikat lacks them. The page offers the same run again.
describe('ProviderStep, underlag left on reversed copies by a re-run migration (#51)', () => {
  const line = sv.extensions.ext_arcim_documents_on_replaced_copies.replace('{count}', '12')
  const RUN = {
    provider: 'fortnox',
    startedAt: '2026-10-22T17:30:00Z',
    updatedAt: '2026-10-22T17:50:20Z',
    complete: true,
    total: 40,
    scanned: 40,
    linked: 0,
    skipped: 40,
    unmatched: 0,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: null,
    stalled: false,
  }
  // The sentence and its action: one attention line (the amber glyph, then
  // the sentence), the action a button in it.
  const attnLine = (html: string) => {
    const start = html.indexOf(line)
    if (start === -1) return null
    const end = html.indexOf('</button>', start)
    return html.slice(html.lastIndexOf('<svg', start), end === -1 ? undefined : end + '</button>'.length)
  }

  it('says how many verifikat lack their underlag and offers Hämta underlag in the same line', () => {
    const html = render({ ...status(true), underlagOnReplacedCopies: 12 })
    const attn = attnLine(html)
    expect(attn).toContain('fill-warning')
    expect(attn).toContain(`>${fetchDocuments}</button>`)
  })

  it('shows nothing when no verifikat is in that state, or for a server that predates the count', () => {
    expect(attnLine(render({ ...status(true), underlagOnReplacedCopies: 0 }))).toBeNull()
    expect(attnLine(render(status(true)))).toBeNull()
  })

  it('shows nothing before a ledger import, or without a connection that serves underlag', () => {
    expect(attnLine(render({ ...status(false), underlagOnReplacedCopies: 12 }))).toBeNull()
    const briox = { ...FORTNOX_CONSENT, id: 'consent-3', provider: 'briox' as const }
    expect(attnLine(render({ ...status(true, [briox]), underlagOnReplacedCopies: 12 }))).toBeNull()
  })

  it('stays quiet while a run is moving on that connection', () => {
    const running = { ...RUN, complete: false, nextCursor: 'file-20', scanned: 20 }
    expect(attnLine(render({ ...status(true), underlagOnReplacedCopies: 12, latestDocumentImport: running }))).toBeNull()
  })

  it('offers the reconnect when the latest run stopped for one', () => {
    const refused = { ...RUN, complete: false, nextCursor: 'file-20', needsReconnect: true, stalled: true }
    const attn = attnLine(render({ ...status(true), underlagOnReplacedCopies: 12, latestDocumentImport: refused }))
    expect(attn).toContain('>Koppla Fortnox igen</button>')
  })

  it('says the same in English', () => {
    const html = render({ ...status(true), underlagOnReplacedCopies: 12 }, 'en')
    expect(html).toContain('12 vouchers lack documents that are still on reversed copies from an earlier import.')
    expect(html).toContain(`>${en.extensions.ext_arcim_documents_fetch_action}</button>`)
  })

  it('runs it on the connection the latest run used: its files are the ones left behind', () => {
    const both = status(true, [FORTNOX_CONSENT, BOKIO_CONSENT])
    expect(replacedCopyUnderlagOffer({ ...both, underlagOnReplacedCopies: 3, latestDocumentImport: { ...RUN, provider: 'bokio' } }, true))
      .toEqual({ consentId: 'consent-2', provider: 'bokio', count: 3, reconnect: false })
    expect(replacedCopyUnderlagOffer({ ...both, underlagOnReplacedCopies: 3 }, true))
      .toEqual({ consentId: 'consent-1', provider: 'fortnox', count: 3, reconnect: false })
  })
})

describe('deep-linked provider preselect (PH 245)', () => {
  // The effect lives in the workspace component, which needs a browser to
  // mount; its rule is pinned on the source, as for the other effects here.
  const source = readFileSync(resolve(__dirname, '../ArcimMigrationWorkspace.tsx'), 'utf8')
  const effect = source.slice(
    source.indexOf('const preselectedRef = useRef(false)'),
    source.indexOf('void handleSelectProvider(provider.id)'),
  )

  it('waits for the connection status before it decides', () => {
    expect(effect).toContain('if (isLoadingStatus) return')
  })

  it('stays on the provider list, where Hämta underlag is, once a migration from that provider ran', () => {
    expect(effect).toMatch(
      /connectionStatus\?\.hasCompletedSieImport &&\s+connectionStatus\.consents\.some\(\(consent\) => consent\.provider === provider\.id\)/,
    )
    const stop = effect.slice(effect.indexOf('connectionStatus.consents.some'))
    expect(stop.indexOf('preselectedRef.current = true\n      return')).toBeGreaterThan(-1)
  })
})
