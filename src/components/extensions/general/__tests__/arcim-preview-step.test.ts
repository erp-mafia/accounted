import { describe, expect, it, vi } from 'vitest'
import { createElement, isValidElement, type ComponentProps, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

/**
 * crm#1118 follow-up: when a provider that serves SIE over the API failed to
 * hand it over, the preview step said "SIE-import krävs" and asked for a file
 * export, whatever the cause. It now names the cause from the preview's
 * classified sieError and offers the way forward. Visma and Bokio, which
 * serve no SIE, keep "SIE-import krävs".
 */

type ButtonProps = { children?: ReactNode; onClick?: unknown }

/** The props of every Button the last render drew, in render order. */
const buttons = vi.hoisted(() => [] as ButtonProps[])

// The real Button, wrapped to keep the props it was rendered with: a server
// render drops handlers from the HTML, so this is where a test sees which
// callback each action runs.
vi.mock('@/components/ui/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/button')>()
  function Button(props: ComponentProps<typeof actual.Button>) {
    buttons.push(props)
    return createElement(actual.Button, props)
  }
  return { ...actual, Button }
})

import { PreviewStep, optionsAfterPreview, sieErrorRemedy, type SieErrorRemedy } from '../ArcimMigrationWorkspace'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

type StepProps = ComponentProps<typeof PreviewStep>
type Preview = NonNullable<StepProps['preview']>
type SieError = NonNullable<Preview['sieError']>
type Key = keyof typeof sv.extensions

function preview(overrides: Partial<Preview> = {}): Preview {
  return {
    consent: { id: 'consent-1', provider: 'fortnox', status: 1 },
    companyInfo: null,
    sieAvailable: false,
    sieStats: null,
    sieError: null,
    sourceYears: [],
    maxSelectedYears: 6,
    assetStats: null,
    hasSieData: false,
    ...overrides,
  }
}

function render(data: Preview, locale: 'sv' | 'en' = 'sv', props: Partial<StepProps> = {}): string {
  buttons.length = 0
  const step = createElement(PreviewStep, {
    preview: data,
    isLoading: false,
    error: null,
    authExpired: false,
    licenseMissing: false,
    selectedYears: [],
    onSelectedYearsChange: () => {},
    onReconnect: () => {},
    onRetry: () => {},
    onContinue: () => {},
    onBack: () => {},
    ...props,
  })
  return renderToString(
    createElement(IntlProvider, { locale, messages: locale === 'en' ? en : sv, timeZone: 'Europe/Stockholm' }, step),
  )
}

/**
 * A wizard string as rendered for a Fortnox connection. `{what}` only occurs
 * in the user-right sentence, which the SIE step fills with the bookkeeping.
 */
function text(key: Key, locale: 'sv' | 'en' = 'sv'): string {
  const messages = (locale === 'en' ? en : sv).extensions as Record<string, string>
  return messages[key].replace(/\{provider\}/g, 'Fortnox').replace(/\{what\}/g, messages.ext_arcim_refused_what_bookkeeping)
}

/** A button's visible text. */
function labelOf(button: ButtonProps): string {
  const parts: string[] = []
  const visit = (node: ReactNode) => {
    if (typeof node === 'string' || typeof node === 'number') parts.push(String(node))
    else if (Array.isArray(node)) node.forEach(visit)
    else if (isValidElement(node)) visit((node.props as { children?: ReactNode }).children)
  }
  visit(button.children)
  return parts.join('').trim()
}

/** The buttons the last render drew besides the step's own Tillbaka and Fortsätt. */
function actionButtons(): ButtonProps[] {
  return buttons.filter((b) => !['Tillbaka', 'Fortsätt'].includes(labelOf(b)))
}

/** Whether the step's Fortsätt button carries the disabled attribute. */
function continueDisabled(html: string): boolean {
  const button = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].find((m) => m[2].includes('Fortsätt'))
  expect(button).toBeDefined()
  return /\sdisabled=""/.test(button![1])
}

const SIE_REQUIRED = 'SIE-import krävs'
const FILE_LINES = ['ext_arcim_sie_error_file', 'ext_arcim_sie_error_file_elsewhere'] as const

describe('PreviewStep, a SIE fetch that failed (crm#1118)', () => {
  it.each<[string, SieError, Key, SieErrorRemedy['action'], (typeof FILE_LINES)[number] | null]>([
    ['an expired connection', { code: 'PROVIDER_AUTH_EXPIRED' }, 'ext_arcim_sie_error_reconnect', 'reconnect', null],
    [
      'a missing permission',
      { code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'permission' },
      'ext_arcim_refused_user_right',
      'reconnect',
      'ext_arcim_sie_error_file',
    ],
    [
      'a plan without Bokföring',
      { code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'license' },
      'ext_arcim_sie_error_module',
      'retry',
      'ext_arcim_sie_error_file_elsewhere',
    ],
    ['a missing integration licence', { code: 'PROVIDER_LICENSE_MISSING' }, 'ext_arcim_sie_error_license', 'retry', 'ext_arcim_sie_error_file'],
    ['a rate limit', { code: 'PROVIDER_RATE_LIMITED' }, 'ext_arcim_sie_error_rate_limited', 'retry', 'ext_arcim_sie_error_file'],
    ['an outage', { code: 'PROVIDER_UPSTREAM_ERROR' }, 'ext_arcim_sie_error_unavailable', 'retry', 'ext_arcim_sie_error_file'],
    ['an unreachable provider', { code: 'PROVIDER_UNREACHABLE' }, 'ext_arcim_sie_error_unavailable', 'retry', 'ext_arcim_sie_error_file'],
    ['a timeout or unknown failure', { code: 'PROVIDER_SIE_FETCH_FAILED' }, 'ext_arcim_sie_error_failed', 'retry', 'ext_arcim_sie_error_file'],
  ])('names %s with one way forward instead of asking for a SIE file', (_cause, sieError, messageKey, action, fileLine) => {
    const onReconnect = vi.fn()
    const onRetry = vi.fn()
    const html = render(preview({ sieError }), 'sv', { onReconnect, onRetry })

    expect(html).toContain(text('ext_arcim_sie_error_title'))
    expect(html).toContain(text(messageKey))
    expect(html).not.toContain(SIE_REQUIRED)

    // One action, and its click runs what its label says.
    const [button, ...others] = actionButtons()
    expect(others).toEqual([])
    expect(labelOf(button)).toBe(
      text(action === 'reconnect' ? 'ext_arcim_sie_error_reconnect_action' : 'ext_arcim_sie_error_retry_action'),
    )
    expect(button.onClick).toBe(action === 'reconnect' ? onReconnect : onRetry)

    // The SIE upload as the way around, from where the books are, except
    // where reconnecting is the whole fix.
    for (const line of FILE_LINES) {
      if (line === fileLine) expect(html).toContain(text(line))
      else expect(html).not.toContain(text(line))
    }
    expect(html.includes(text('ext_arcim_sie_error_file_link'))).toBe(fileLine !== null)

    // Nothing to continue with until the ledger is in.
    expect(continueDisabled(html)).toBe(true)
  })

  it('does not call a failure without a class temporary', () => {
    const html = render(preview({ sieError: { code: 'PROVIDER_SIE_FETCH_FAILED' } }))

    expect(html).toContain(text('ext_arcim_sie_error_failed'))
    expect(html).not.toContain(text('ext_arcim_sie_error_unavailable'))
  })

  it('still lets a company whose ledger is already imported continue to the registers, and says why the ledger did not come', () => {
    const html = render(preview({ sieError: { code: 'PROVIDER_RATE_LIMITED' }, hasSieData: true }))

    expect(html).toContain(text('ext_arcim_sie_error_rate_limited'))
    expect(continueDisabled(html)).toBe(false)
  })

  it('speaks English to an English user', () => {
    const html = render(preview({ sieError: { code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'permission' } }), 'en')

    expect(html).toContain(text('ext_arcim_sie_error_title', 'en'))
    expect(html).toContain(text('ext_arcim_refused_user_right', 'en'))
    expect(html).toContain(text('ext_arcim_sie_error_reconnect_action', 'en'))
    expect(html).not.toContain(text('ext_arcim_refused_user_right'))
  })

  it('leaves the cause to the error block when a reload of the preview failed', () => {
    const html = render(preview({ sieError: { code: 'PROVIDER_RATE_LIMITED' } }), 'sv', {
      error: 'Anslutningen till leverantören har gått ut. Återanslut för att fortsätta.',
      authExpired: true,
    })

    expect(html).toContain('Kunde inte hämta bokföringsdata')
    expect(html).not.toContain(text('ext_arcim_sie_error_rate_limited'))
  })
})

describe('PreviewStep, a provider that serves no SIE over the API', () => {
  it('keeps asking for the SIE file for Visma and Bokio', () => {
    for (const provider of ['visma', 'bokio'] as const) {
      const html = render(preview({ consent: { id: 'consent-1', provider, status: 1 } }))

      expect(html).toContain(SIE_REQUIRED)
      expect(html).not.toContain(sv.extensions.ext_arcim_sie_error_title.split('{provider}')[0])
      expect(continueDisabled(html)).toBe(true)
    }
  })
})

describe('sieErrorRemedy', () => {
  it.each<[SieError, SieErrorRemedy]>([
    [{ code: 'PROVIDER_AUTH_EXPIRED' }, { kind: 'reconnect', action: 'reconnect', file: null }],
    [{ code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'permission' }, { kind: 'permission', action: 'reconnect', file: 'provider' }],
    // A refusal without a reason reads as the permission it usually is.
    [{ code: 'PROVIDER_RESOURCE_FORBIDDEN' }, { kind: 'permission', action: 'reconnect', file: 'provider' }],
    [{ code: 'PROVIDER_RESOURCE_FORBIDDEN', reason: 'license' }, { kind: 'module', action: 'retry', file: 'elsewhere' }],
    [{ code: 'PROVIDER_LICENSE_MISSING' }, { kind: 'license', action: 'retry', file: 'provider' }],
    [{ code: 'PROVIDER_API_MODULE_INACTIVE' }, { kind: 'license', action: 'retry', file: 'provider' }],
    [{ code: 'PROVIDER_RATE_LIMITED' }, { kind: 'rate_limited', action: 'retry', file: 'provider' }],
    [{ code: 'PROVIDER_UPSTREAM_ERROR' }, { kind: 'unavailable', action: 'retry', file: 'provider' }],
    [{ code: 'PROVIDER_UNREACHABLE' }, { kind: 'unavailable', action: 'retry', file: 'provider' }],
    [{ code: 'PROVIDER_SIE_FETCH_FAILED' }, { kind: 'failed', action: 'retry', file: 'provider' }],
    [{ code: 'PROVIDER_CONFIGURATION_ERROR' }, { kind: 'failed', action: 'retry', file: 'provider' }],
  ])('%o asks for %o', (sieError, remedy) => {
    expect(sieErrorRemedy(sieError)).toEqual(remedy)
  })
})

describe('optionsAfterPreview', () => {
  const OPTIONS: Parameters<typeof optionsAfterPreview>[0] = {
    importCompanyInfo: true,
    importSIEData: true,
    importCustomers: true,
    importSuppliers: true,
    importSalesInvoices: true,
    importSupplierInvoices: true,
    importPaidSupplierInvoices: false,
    importAssets: true,
    voucherSeries: 'B',
    replaceImportedYears: [],
    onlyUsedAccounts: false,
  }

  it('unticks the SIE import when the preview could not fetch the ledger, and ticks it again when a retry could', () => {
    const afterFailure = optionsAfterPreview(OPTIONS, false)
    expect(afterFailure.importSIEData).toBe(false)

    expect(optionsAfterPreview(afterFailure, true).importSIEData).toBe(true)
  })

  it('leaves every other option as the user set it', () => {
    const chosen = { ...OPTIONS, importCustomers: false, importAssets: false, voucherSeries: 'C' }

    expect(optionsAfterPreview(chosen, true)).toEqual({ ...chosen, importSIEData: true })
  })
})

describe('PreviewStep error copy', () => {
  it('has every sentence and action in both languages', () => {
    const keys = [
      'title',
      'reconnect',
      'module',
      'license',
      'rate_limited',
      'unavailable',
      'failed',
      'reconnect_action',
      'retry_action',
      'file',
      'file_elsewhere',
      'file_link',
    ]
    for (const messages of [sv, en]) {
      const extensions = messages.extensions as Record<string, string>
      for (const key of keys) expect(extensions[`ext_arcim_sie_error_${key}`], key).toEqual(expect.any(String))
      // A permission reads the user-right sentence every refusal shares.
      for (const key of ['ext_arcim_refused_user_right', 'ext_arcim_refused_what_bookkeeping']) {
        expect(extensions[key], key).toEqual(expect.any(String))
      }
    }
  })
})
