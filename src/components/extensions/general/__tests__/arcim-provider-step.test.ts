import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

import { ProviderStep, offeredProviders } from '../ArcimMigrationWorkspace'

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

  it('does not offer underlag before there are verifikat to link them to', () => {
    expect(render(status(false))).not.toContain(fetchDocuments)
  })
})

describe('ProviderStep, a company with an imported ledger', () => {
  it('keeps Synka igen, the underlag import and the heading for another system', () => {
    const html = render(status(true))
    expect(html).toContain(sv.extensions.ext_arcim_resync)
    expect(html).toContain(fetchDocuments)
    expect(html).toContain(`Använd &quot;${sv.extensions.ext_arcim_resync}&quot; ovan`)
    expect(html).toContain(connectAnother)
    expect(html).not.toContain(sv.extensions.ext_arcim_continue_import)
    expect(html).not.toContain(sv.extensions.ext_arcim_continue_import_heading)
  })
})

describe('ProviderStep, a Visma or Bokio connection before the SIE upload', () => {
  it('keeps Synka igen, since the ledger has to come in as a SIE file first', () => {
    const html = render(status(false, [BOKIO_CONSENT]))
    expect(html).toContain(sv.extensions.ext_arcim_resync)
    expect(html).not.toContain(sv.extensions.ext_arcim_continue_import)
    expect(html).toContain('Ladda upp SIE-fil')
    expect(html).toContain(`Använd &quot;${sv.extensions.ext_arcim_resync}&quot; ovan`)
  })

  it('labels each connection by what it can do when Fortnox and Bokio sit side by side', () => {
    const html = render(status(false, [FORTNOX_CONSENT, BOKIO_CONSENT]))
    expect(html).toContain(sv.extensions.ext_arcim_continue_import)
    expect(html).toContain(sv.extensions.ext_arcim_resync)
  })
})

describe('ProviderStep in English', () => {
  it('names the connection action and points at it in the same language, imported or not', () => {
    for (const imported of [false, true]) {
      const action = imported ? en.extensions.ext_arcim_resync : en.extensions.ext_arcim_continue_import
      const html = render(status(imported), 'en')
      expect(html).toContain(`Use &quot;${action}&quot; above`)
      expect(html).not.toContain(sv.extensions.ext_arcim_resync)
    }
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
