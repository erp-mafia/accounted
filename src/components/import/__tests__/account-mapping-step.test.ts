import { describe, expect, it, vi } from 'vitest'
import { createElement, isValidElement, type ComponentProps, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'
import type { AccountMapping } from '@/lib/import/types'
import type { ImportNotice } from '@/lib/import/notices'
import type { BASAccount } from '@/types'

type StubProps = { children?: ReactNode } & Record<string, unknown>

/** The props each Select and SelectContent stub received, in render order. */
const rendered = vi.hoisted(() => [] as Array<{ part: 'select' | 'content'; props: StubProps }>)

// Radix renders a closed Select's items into a detached fragment from an
// effect, which a server render never runs, so the real primitive would hide
// exactly what these tests count. The stubs render every item the step asks
// for inline: the HTML then shows what a page of closed pickers mounts.
vi.mock('@/components/ui/select', () => {
  function Select(props: StubProps) {
    rendered.push({ part: 'select', props })
    return createElement('div', null, props.children)
  }
  function SelectTrigger({ children }: { children?: ReactNode }) {
    return createElement('button', null, children)
  }
  function SelectValue() {
    return null
  }
  function SelectContent(props: StubProps) {
    rendered.push({ part: 'content', props })
    return createElement('div', null, props.children)
  }
  function SelectItem({ value, children }: { value: string; children?: ReactNode }) {
    return createElement('div', { 'data-option': value }, children)
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

import AccountMappingStep, { TargetAccountOptions } from '../AccountMappingStep'
import { TooltipProvider } from '@/components/ui/info-tooltip'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

/** The BAS catalogue as the mapping step receives it: the real list, about 1,300 accounts. */
const CHART = BAS_REFERENCE.map((account) => ({
  account_number: account.account_number,
  account_name: account.account_name,
  account_class: Number(account.account_number.charAt(0)),
})) as BASAccount[]

/** A class 3/4 account mapped to itself with a suggested momskod awaiting review, as a Fortnox chart arrives. */
function pendingRow(account: { account_number: string; account_name: string }): AccountMapping {
  return {
    sourceAccount: account.account_number,
    sourceName: account.account_name,
    targetAccount: account.account_number,
    targetName: account.account_name,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
    defaultVatTreatment: 'standard_25',
    defaultVatRate: 0.25,
    vatTreatmentSuggested: true,
    vatTreatmentReviewed: false,
    requiresVatTreatmentReview: true,
  }
}

const PENDING = CHART.filter((a) => a.account_class === 3 || a.account_class === 4)
  .slice(0, 60)
  .map(pendingRow)

function render(
  mappings: AccountMapping[],
  extra: { notices?: ImportNotice[] } = {},
): string {
  rendered.length = 0
  const step = createElement(AccountMappingStep, {
    mappings,
    basAccounts: CHART,
    onMappingChange: () => {},
    onVatTreatmentChange: () => {},
    onConfirmAllVatTreatments: () => {},
    onContinue: () => {},
    onBack: () => {},
    ...(extra.notices
      ? {
          onSourceChartSelected: () => {},
          sourceChart: {
            summary: { formatLabel: null, treatmentsApplied: 0, accountsWithoutTreatment: [] },
            notices: extra.notices,
          } as unknown as ComponentProps<typeof AccountMappingStep>['sourceChart'],
        }
      : {}),
  })
  return renderToString(
    createElement(
      IntlProvider,
      { locale: 'sv', messages: sv, timeZone: 'Europe/Stockholm' },
      createElement(TooltipProvider, null, step),
    ),
  )
}

/** Mounted options whose value is an account number: the target pickers' options. */
function accountOptions(html: string): string[] {
  return [...html.matchAll(/data-option="(\d{4})"/g)].map((m) => m[1])
}

/**
 * The target pickers of the last render: each content holding the account
 * options, with the Select it belongs to (the Select rendered just before).
 */
function targetPickers(): Array<{ select: StubProps; content: StubProps }> {
  const pickers: Array<{ select: StubProps; content: StubProps }> = []
  let select: StubProps | null = null
  for (const { part, props } of rendered) {
    if (part === 'select') select = props
    else if (select && isValidElement(props.children) && props.children.type === TargetAccountOptions) {
      pickers.push({ select, content: props })
    }
  }
  return pickers
}

describe('AccountMappingStep target picker (crm#1118)', () => {
  it('mounts one option per closed picker, not the chart on every row', () => {
    const html = render(PENDING)
    const mounted = accountOptions(html)
    // 50 rows on the first page, each mounting only its own target. Before,
    // every row mounted the whole chart: about 64,000 options on one page,
    // which is what reloaded the tab on an iPhone.
    expect(mounted).toHaveLength(50)
    expect(mounted).toEqual(PENDING.slice(0, 50).map((m) => m.targetAccount))
    expect(CHART.length).toBeGreaterThan(1000)
  })

  it('still names the selection on a closed trigger: a chart account, a created one, none', () => {
    const known = new Set(CHART.map((a) => a.account_number))
    const outside = Array.from({ length: 1000 }, (_, i) => String(3000 + i)).find(
      (n) => !known.has(n),
    )!
    const created = { ...pendingRow({ account_number: outside, account_name: 'Egen intäkt' }), matchType: 'bas_range' as const }
    const unmapped: AccountMapping = {
      ...pendingRow({ account_number: '0099', account_name: 'Systemkonto' }),
      targetAccount: '',
      targetName: '',
      confidence: 0,
      matchType: 'class',
      requiresVatTreatmentReview: false,
    }
    // The unmapped row puts the step on its "ej mappade" filter; the other
    // two are shown under "Visa alla", so render them on their own as well.
    const withUnmapped = render([unmapped, PENDING[0]])
    expect(withUnmapped).toContain('data-option="none">-- Välj konto --')

    const html = render([PENDING[0], created])
    expect(html).toContain(`data-option="${PENDING[0].targetAccount}"`)
    expect(html).toContain(PENDING[0].targetName)
    expect(html).toMatch(new RegExp(`data-option="${outside}">.*?Egen intäkt.*?${sv.chart_of_accounts.new_account_option}`))
  })

  it('wires each picker to open its list and to drop it once the list has left the screen', () => {
    render(PENDING)
    const pickers = targetPickers()
    expect(pickers).toHaveLength(50)
    for (const { select, content } of pickers) {
      // Controlled and closed: without onOpenChange it could never open.
      expect(select.open).toBe(false)
      expect(select.onOpenChange).toBeTypeOf('function')
      // Closed, the content mounts the selected option only.
      const options = content.children
      expect(isValidElement<{ selectedOnly: boolean }>(options) && options.props.selectedOnly).toBe(true)
      // After closing, the list goes when the fade-out ends, or when the
      // content unmounts if no fade ran.
      expect(content.onAnimationEnd).toBeTypeOf('function')
      expect(content.onCloseAutoFocus).toBeTypeOf('function')
    }
  })

  it('TargetAccountOptions without selectedOnly renders the whole list an open picker shows', () => {
    const html = renderToString(
      createElement(
        IntlProvider,
        { locale: 'sv', messages: sv, timeZone: 'Europe/Stockholm' },
        createElement(TargetAccountOptions, {
          mapping: PENDING[0],
          knownTargets: new Set(CHART.map((a) => a.account_number)),
          accountsByClass: { 'Klass 3': CHART.filter((a) => a.account_class === 3), 'Klass 4': CHART.filter((a) => a.account_class === 4) },
          accountByNumber: new Map(CHART.map((a) => [a.account_number, a])),
          selectedOnly: false,
        }),
      ),
    )
    const classes34 = CHART.filter((a) => a.account_class === 3 || a.account_class === 4)
    expect(accountOptions(html)).toHaveLength(classes34.length)
    expect(html).toContain('data-option="none"')
  })
})

describe('AccountMappingStep VAT review gate (crm#1118)', () => {
  const gate = (count: number) =>
    `${count} föreslagna momskoder behöver bekräftas innan du kan fortsätta.`

  it('says what blocks Continue where the step opens, with the bulk confirm in the sentence', () => {
    const html = render(PENDING)
    const gateAt = html.indexOf(gate(60))
    expect(gateAt).toBeGreaterThan(-1)
    // Above the table, not only under its 50 rows.
    expect(gateAt).toBeLessThan(html.indexOf('<table'))
    expect(html.indexOf('Bekräfta alla föreslagna (60)')).toBeLessThan(html.indexOf('<table'))
  })

  it('is absent when an account is unmapped, when nothing awaits review, and behind a chart file notice', () => {
    const unmapped: AccountMapping = { ...PENDING[1], targetAccount: '', targetName: '' }
    expect(render([PENDING[0], unmapped])).not.toContain('behöver bekräftas innan du kan fortsätta')

    const reviewed = PENDING.map((m) => ({ ...m, vatTreatmentReviewed: true }))
    expect(render(reviewed)).not.toContain('behöver bekräftas innan du kan fortsätta')

    const notice: ImportNotice = { code: 'legacy', severity: 'action', params: { text: 'Fel år i kontoplanen' } }
    const html = render(PENDING, { notices: [notice] })
    expect(html).toContain('Fel år i kontoplanen')
    expect(html).not.toContain(gate(60))
  })
})
