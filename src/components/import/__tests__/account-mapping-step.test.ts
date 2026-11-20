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

import AccountMappingStep, { TargetAccountOptions, rowsInView } from '../AccountMappingStep'
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

describe('AccountMappingStep reverse-charge basis on a separate pair (crm#1096)', () => {
  const MARCH = new Date(2026, 2, 1).getTime()
  const pairOf = (legs: string[], offsets: string[], vouchers = 8) => ({ legs, offsets, vouchers, lastAt: MARCH })
  /** A row 8 vouchers book beside a 4535/4599 pair that the file ends on, with no momskod on it. */
  const row = (account: string, name: string, overrides: Partial<AccountMapping> = {}): AccountMapping => ({
    ...pendingRow({ account_number: account, account_name: name }),
    defaultVatTreatment: null,
    defaultVatRate: null,
    vatTreatmentSuggested: false,
    rcBasisPair: { pairs: [pairOf(['4535'], ['4599'])] },
    ...overrides,
  })
  const PAIR_NOTE = 'redovisar underlaget för omvänd moms på ett separat kontopar'

  it('says why no reverse-charge momskod is suggested where the prefill set one aside', () => {
    const coded = render([row('5420', 'Programvaror', {
      providerVatCode: 'ITEU',
      providerVatTreatment: 'reverse_charge_eu_services',
    })])
    expect(coded).toContain(
      'Momskod i källsystemet: ITEU. Den används inte: 8 verifikat på kontot redovisar underlaget för omvänd moms på ett separat kontopar (4535, 4599), så momskoden skulle räkna de inköpen två gånger.',
    )

    const labelled = render([row('6545', 'Inköp tjänster utanför EU 25%')])
    expect(labelled).toContain(
      '8 verifikat på kontot redovisar underlaget för omvänd moms på ett separat kontopar (4535, 4599), så ingen momskod för omvänd moms föreslås: den skulle räkna de inköpen två gånger.',
    )
  })

  it('warns on a reverse-charge momskod that counts those purchases twice, whoever set it', () => {
    const html = render([row('5420', 'Programvaror', {
      defaultVatTreatment: 'reverse_charge_eu_services',
      // The file ends on the account's own basis: the momskod stays, with the cost.
      rcBasisPair: { pairs: [pairOf(['4535'], ['4599'], 1)], ownBasisLastAt: MARCH + 1 },
    })])
    expect(html).toContain(
      '1 verifikat på kontot redovisar underlaget för omvänd moms på ett separat kontopar (4535, 4599): med den här momskoden räknas det inköpet två gånger i momsdeklarationen.',
    )
  })

  it('keeps the source-code line on a row where no reverse-charge momskod was set aside', () => {
    // No code and a label that names no reverse charge: nothing was on the table.
    expect(render([row('5420', 'Programvaror')])).not.toContain(PAIR_NOTE)

    // A code nothing could translate still says so.
    const unreadable = render([row('5420', 'Programvaror', { providerVatCode: 'XYZ', providerVatTreatment: null })])
    expect(unreadable).toContain('Momskod i källsystemet: XYZ. Den gick inte att tolka och kontonamnet ger ingen ledtråd')
    expect(unreadable).not.toContain(PAIR_NOTE)

    // A code that is applied and reports elsewhere (trepartshandel, ruta 37) is in use.
    const applied = render([row('4056', 'Inköp varor trepartshandel', {
      providerVatCode: '37',
      providerVatTreatment: 'triangulation_eu_goods',
      defaultVatTreatment: 'triangulation_eu_goods',
    })])
    expect(applied).toContain('Momskod i källsystemet: 37')
    expect(applied).not.toContain('Den används inte')
    expect(applied).not.toContain(PAIR_NOTE)
  })

  it('says nothing about a pair whose leg does not report ruta 20-24, and warns once it does', () => {
    const cost = row('4051', 'Inköp varor EU 25%', {
      defaultVatTreatment: 'reverse_charge_eu_goods',
      rcBasisPair: { pairs: [pairOf(['4505'], ['4599'])] },
    })
    const leg = (treatment: AccountMapping['defaultVatTreatment']) => row('4505', 'Underlag', {
      defaultVatTreatment: treatment,
      rcBasisPair: undefined,
    })
    expect(render([cost, leg(null)])).not.toContain(PAIR_NOTE)
    expect(render([cost, leg('import_goods')])).not.toContain(PAIR_NOTE)
    expect(render([cost, leg('reverse_charge_eu_goods')])).toContain(
      '8 verifikat på kontot redovisar underlaget för omvänd moms på ett separat kontopar (4505, 4599): med den här momskoden',
    )
  })

  it('adds nothing to a row without a pair beside it', () => {
    const html = render([pendingRow({ account_number: '5420', account_name: 'Programvaror' })])
    expect(html).not.toContain(PAIR_NOTE)
  })
})

describe('AccountMappingStep answered rows stay in the review view (O20)', () => {
  const [A, B, C] = PENDING.slice(0, 3)
  const NONE = new Set<string>()
  const KNOWN = new Set(CHART.map((a) => a.account_number))
  const confirmed = (m: AccountMapping): AccountMapping => ({ ...m, vatTreatmentSuggested: false, vatTreatmentReviewed: true })
  const accounts = (rows: AccountMapping[]) => rows.map((m) => m.sourceAccount)

  it('keeps a row confirmed in this view in its place, so the next row does not move under the pointer', () => {
    const before = rowsInView([A, B, C], 'vat_review', '', KNOWN, NONE)
    const after = rowsInView([confirmed(A), B, C], 'vat_review', '', KNOWN, new Set([A.sourceAccount]))
    expect(accounts(after)).toEqual(accounts(before))
  })

  it('drops answered rows once the view changes (the caller empties the set), and pending rows stay', () => {
    expect(accounts(rowsInView([confirmed(A), B, C], 'vat_review', '', KNOWN, NONE)))
      .toEqual([B.sourceAccount, C.sourceAccount])
    expect(accounts(rowsInView([confirmed(A), B, C], 'all', '', KNOWN, NONE)))
      .toEqual([A.sourceAccount, B.sourceAccount, C.sourceAccount])
  })

  it('applies filter and search as before to rows not answered here', () => {
    const unmapped: AccountMapping = { ...C, targetAccount: '', targetName: '' }
    expect(accounts(rowsInView([A, B, unmapped], 'unmapped', '', KNOWN, NONE))).toEqual([C.sourceAccount])
    expect(accounts(rowsInView([A, B, C], 'vat_review', B.sourceAccount, KNOWN, NONE))).toEqual([B.sourceAccount])
    expect(accounts(rowsInView([A, B, C], 'vat_review', B.sourceName.toUpperCase(), KNOWN, NONE)))
      .toEqual([B.sourceAccount])
    // A row mapped in the unmapped view stays there until the view changes.
    expect(accounts(rowsInView([A, B, C], 'unmapped', '', KNOWN, new Set([C.sourceAccount])))).toEqual([C.sourceAccount])
  })

  it('shows a confirmed row as done, with no confirm button', () => {
    const html = render([confirmed(A), confirmed(B)])
    expect(html).toContain('Bekräftad')
    expect(html).not.toContain(`aria-label="Bekräfta: ${A.sourceAccount}"`)

    const pending = render([A])
    expect(pending).toContain(`aria-label="Bekräfta: ${A.sourceAccount}"`)
    expect(pending).not.toContain('Bekräftad')
  })
})

describe('AccountMappingStep match column', () => {
  const row = (overrides: Partial<AccountMapping>): AccountMapping => ({
    sourceAccount: '1930',
    sourceName: 'Företagskonto',
    targetAccount: '1930',
    targetName: 'Företagskonto',
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
    ...overrides,
  })
  // A valid number outside the BAS reference, mapped to itself: what the
  // mapper does with most rows of a chart that keeps its own sub-accounts.
  const fromFile = row({
    sourceAccount: '4599',
    sourceName: 'Eget inköpskonto',
    targetAccount: '4599',
    targetName: 'Eget inköpskonto',
    confidence: 0.7,
    matchType: 'bas_range',
  })

  it('names what the mapper did on each row', () => {
    const html = render([
      row({}),
      fromFile,
      row({ sourceAccount: '2640', sourceName: 'Ingående moms', targetAccount: '2641', targetName: 'Debiterad ingående moms' }),
      row({ sourceAccount: '9999', sourceName: 'Observationskonto', targetAccount: '2999', targetName: 'OBS-konto', confidence: 0.5, matchType: 'class' }),
      row({ sourceAccount: '1510', sourceName: 'Kundfordringar', targetAccount: '1510', targetName: 'Kundfordringar', isOverride: true }),
    ])
    expect(html).toContain('>Matchning<')
    expect(html).toContain('>BAS-konto<')
    expect(html).toContain('>Från filen<')
    expect(html).toContain('>Flyttad<')
    expect(html).toContain('>Osäker<')
    expect(html).toContain('>Manuell<')
  })

  it('does not grade a self-mapped account outside the BAS reference as likely', () => {
    const html = render([fromFile])
    expect(html).toContain('>Från filen<')
    expect(html).not.toContain('Trolig')
    expect(html).not.toContain('Konfidens')
  })

  it('leaves the cell empty on an unmapped row', () => {
    const html = render([row({ sourceAccount: '9999', sourceName: 'Observationskonto', targetAccount: '', targetName: '', confidence: 0, matchType: 'manual' })])
    for (const label of ['>BAS-konto<', '>Från filen<', '>Flyttad<', '>Osäker<', '>Manuell<']) {
      expect(html).not.toContain(label)
    }
  })

  it('keeps the columns inside the content column of a 1440px window', () => {
    // The content column where the sidebar turns wide: 1440 minus the rail
    // (96), the wide sidebar (320), the frame gutter (10) and the page padding
    // (48). A wider table slides the match column under the sticky confirm
    // column there.
    const CONTENT_COLUMN = 966
    const head = render([row({})]).match(/<thead[\s\S]*?<\/thead>/)?.[0] ?? ''
    const widths = [...head.matchAll(/<th\s[^>]*?class="([^"]*)"/g)].map((th) => {
      const width = th[1].split(/\s+/).find((name) => /^w-\d+$/.test(name))
      return width ? Number(width.slice(2)) * 4 : Number.NaN
    })
    expect(widths).toHaveLength(7)
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(CONTENT_COLUMN)
  })

  it('writes a text label on one line', () => {
    expect(render([row({})])).toMatch(/<span class="[^"]*\bwhitespace-nowrap\b[^"]*">BAS-konto<\/span>/)
  })
})
