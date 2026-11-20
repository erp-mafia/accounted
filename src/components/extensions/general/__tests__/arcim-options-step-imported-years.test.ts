import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider, createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

import { DEFAULT_OPTIONS, OptionsStep, optionsAfterSieData, sieFilesToImport } from '../ArcimMigrationWorkspace'

/**
 * PH 185, PH 180 (and PH 163 before them): running the migration guide
 * again for a company whose fiscal years a completed import already held
 * (an SIE upload, or an earlier provider run) replaced every one of those
 * years by default. Each replacement makulerade the earlier import's
 * verifikat and booked the year again under new numbers, leaving hundreds to
 * thousands of reversed verifikat. A re-run now keeps those years; importing
 * one again is a checkbox per year that names what it does.
 */

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

type StepProps = ComponentProps<typeof OptionsStep>
type Options = StepProps['options']
type SieData = NonNullable<StepProps['sieData']>
type FileStatus = SieData['fileStatuses'][number]

function file(fiscalYear: number, previousImportId: string | null = null): FileStatus {
  return {
    fiscalYear,
    storagePath: `company/sie-intake/${fiscalYear}.se`,
    filename: `migration-sie-${fiscalYear}.se`,
    bytes: 1000,
    voucherCount: 100,
    alreadyImported: previousImportId !== null,
    importedAt: previousImportId ? '2026-10-12T19:11:00Z' : null,
    previousImport: previousImportId
      ? {
          id: previousImportId,
          importedAt: '2026-10-12T19:11:00Z',
          fiscalYearStart: `${fiscalYear}-01-01`,
          fiscalYearEnd: `${fiscalYear}-12-31`,
        }
      : null,
  }
}

const BASE_OPTIONS: Options = {
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

/** The shape of the second run in PH 185: two older years added, three already imported. */
const SECOND_RUN = [
  file(2022),
  file(2023),
  file(2024, 'import-2024'),
  file(2025, 'import-2025'),
  file(2026, 'import-2026'),
]

/** PH 180: every year uploaded as an SIE file before the Fortnox run. */
const AFTER_SIE_UPLOAD = [
  file(2023, 'upload-2023'),
  file(2024, 'upload-2024'),
  file(2025, 'upload-2025'),
  file(2026, 'upload-2026'),
]

function sieData(fileStatuses: FileStatus[]): SieData {
  const replaced = fileStatuses.filter((f) => f.previousImport).length
  return {
    theater: {} as SieData['theater'],
    mappings: [],
    mappingStats: { total: 0, mapped: 0, unmapped: 0 },
    fileStatuses,
    allImported: false,
    newFileCount: fileStatuses.length - replaced,
    replacedFileCount: replaced,
    failedYears: [],
    omittedYears: [],
    basAccounts: [],
  }
}

function render(fileStatuses: FileStatus[], options: Options, locale: 'sv' | 'en' = 'sv',
  preview?: SieData['preview']): string {
  const step = createElement(OptionsStep, {
    options,
    sieAvailable: true,
    sieData: { ...sieData(fileStatuses), ...(preview ? { preview } : {}) },
    hasSieData: true,
    provider: 'fortnox',
    isStarting: false,
    onChange: () => {},
    onStart: () => {},
    onBack: () => {},
  })
  return renderToString(
    createElement(
      IntlProvider,
      { locale, messages: locale === 'en' ? en : sv, timeZone: 'Europe/Stockholm' },
      step,
    ),
  )
}

/** The aria-checked of the first switch after the "Bokföringsdata (SIE)" label. */
function sieSwitchChecked(html: string): boolean {
  const row = html.slice(html.indexOf('Bokföringsdata (SIE)'))
  const button = row.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? ''
  return /aria-checked="true"/.test(button)
}

const tSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'extensions' })
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'extensions' })

describe('optionsAfterSieData', () => {
  it('leaves the ledger unticked when every fetched year is already imported (PH 180)', () => {
    const options = optionsAfterSieData(BASE_OPTIONS, AFTER_SIE_UPLOAD)
    expect(options.importSIEData).toBe(false)
    expect(options.replaceImportedYears).toEqual([])
  })

  it('ticks the ledger when at least one year is new', () => {
    expect(optionsAfterSieData(BASE_OPTIONS, SECOND_RUN).importSIEData).toBe(true)
  })

  it('ticks the ledger on a first run, where no year is imported yet', () => {
    expect(optionsAfterSieData({ ...BASE_OPTIONS, importSIEData: false }, [file(2025), file(2026)]).importSIEData).toBe(true)
  })

  it('drops a replacement chosen for an earlier selection of years', () => {
    const options = optionsAfterSieData({ ...BASE_OPTIONS, replaceImportedYears: [2025] }, SECOND_RUN)
    expect(options.replaceImportedYears).toEqual([])
  })
})

describe('sieFilesToImport', () => {
  it('imports only the new years on a re-run and never sends a supersede (PH 185)', () => {
    const files = sieFilesToImport(SECOND_RUN, optionsAfterSieData(BASE_OPTIONS, SECOND_RUN))
    expect(files.map((f) => f.fiscalYear)).toEqual([2022, 2023])
    expect(files.every((f) => f.previousImport === null)).toBe(true)
  })

  it('imports nothing after an SIE upload of every year (PH 180)', () => {
    expect(sieFilesToImport(AFTER_SIE_UPLOAD, optionsAfterSieData(BASE_OPTIONS, AFTER_SIE_UPLOAD))).toEqual([])
  })

  it('replaces exactly the years ticked by hand, oldest first, each naming its predecessor', () => {
    const files = sieFilesToImport([...SECOND_RUN].reverse(), { importSIEData: true, replaceImportedYears: [2026, 2024] })
    expect(files.map((f) => [f.fiscalYear, f.previousImport?.id ?? null])).toEqual([
      [2022, null],
      [2023, null],
      [2024, 'import-2024'],
      [2026, 'import-2026'],
    ])
  })

  it('imports every year of a first run', () => {
    const files = sieFilesToImport([file(2024), file(2025), file(2026)], BASE_OPTIONS)
    expect(files.map((f) => f.fiscalYear)).toEqual([2024, 2025, 2026])
  })

  it('skips the new years when the ledger is unticked, and keeps a replacement ticked by hand', () => {
    const files = sieFilesToImport(SECOND_RUN, { importSIEData: false, replaceImportedYears: [2026] })
    expect(files.map((f) => f.fiscalYear)).toEqual([2026])
  })
})

describe('OptionsStep, a re-run over already imported years', () => {
  it('names each imported year as kept and never says it will be replaced', () => {
    const html = render(SECOND_RUN, optionsAfterSieData(BASE_OPTIONS, SECOND_RUN))
    for (const year of [2024, 2025, 2026]) {
      expect(html).toContain(tSv('ext_arcim_option_sie_year_kept', { year }))
      expect(html).not.toContain(tSv('ext_arcim_option_sie_year_replacing', { year }))
    }
    expect(html).toContain(tSv('ext_arcim_option_sie_year_new', { year: 2022 }))
    expect(html).toContain(tSv('ext_arcim_option_sie_desc_new_and_kept', { newCount: 2, keptCount: 3 }))
    expect(html).toContain(tSv('ext_arcim_option_sie_replace_help'))
    // The wording that used to promise a replacement is gone.
    expect(html).not.toContain('ersätter tidigare import')
    expect(html).not.toContain('tidigare import ersätts')
  })

  it('says every year is already imported when nothing is new (PH 180)', () => {
    const html = render(AFTER_SIE_UPLOAD, optionsAfterSieData(BASE_OPTIONS, AFTER_SIE_UPLOAD))
    expect(html).toContain(tSv('ext_arcim_option_sie_desc_all_kept'))
    // Nothing new to import: no voucher series to choose.
    expect(html).not.toContain('Verifikationsserie')
  })

  // Rage clicks on the replace box (I07): with every year already imported,
  // the ledger row above it stayed off with "every year is already imported"
  // after a year was ticked, so the tick read as not taken.
  it('turns the ledger row on and says a year is imported again once one is ticked', () => {
    const kept = render(AFTER_SIE_UPLOAD, optionsAfterSieData(BASE_OPTIONS, AFTER_SIE_UPLOAD))
    expect(sieSwitchChecked(kept)).toBe(false)

    const html = render(AFTER_SIE_UPLOAD, { ...optionsAfterSieData(BASE_OPTIONS, AFTER_SIE_UPLOAD), replaceImportedYears: [2026] })
    expect(sieSwitchChecked(html)).toBe(true)
    expect(html).toContain(tSv('ext_arcim_option_sie_desc_replacing', { count: 1 }))
    expect(html).not.toContain(tSv('ext_arcim_option_sie_desc_all_kept'))
    expect(html).toContain(tSv('ext_arcim_option_sie_year_replacing', { year: 2026 }))

    const en = render(AFTER_SIE_UPLOAD, { ...optionsAfterSieData(BASE_OPTIONS, AFTER_SIE_UPLOAD), replaceImportedYears: [2025, 2026] }, 'en')
    expect(en).toContain(tEn('ext_arcim_option_sie_desc_replacing', { count: 2 }))
  })

  it('names a year ticked for replacement as replacing the earlier import', () => {
    const html = render(SECOND_RUN, { ...optionsAfterSieData(BASE_OPTIONS, SECOND_RUN), replaceImportedYears: [2026] })
    expect(html).toContain(tSv('ext_arcim_option_sie_year_replacing', { year: 2026 }))
    expect(html).toContain(tSv('ext_arcim_option_sie_year_kept', { year: 2025 }))
  })

  it('renders the same step in English', () => {
    const html = render(SECOND_RUN, optionsAfterSieData(BASE_OPTIONS, SECOND_RUN), 'en')
    expect(html).toContain(tEn('ext_arcim_option_sie_year_kept', { year: 2024 }))
    expect(html).toContain(tEn('ext_arcim_option_sie_desc_new_and_kept', { newCount: 2, keptCount: 3 }))
  })
})

describe('the confirm dialog sentences', () => {
  it('name the makulering and the new numbers for a replaced year, in both languages', () => {
    const one = tSv('ext_arcim_confirm_sie_replace', { count: 1, years: '2026', appName: 'accounted' })
    expect(one).toContain('Räkenskapsår 2026 importeras om')
    expect(one).toContain('makuleras')
    expect(one).toContain('nya verifikationsnummer')
    const many = tEn('ext_arcim_confirm_sie_replace', { count: 2, years: '2024, 2026', appName: 'accounted' })
    expect(many).toContain('Fiscal years 2024, 2026 are imported again')
  })

  it('name the kept years', () => {
    expect(tSv('ext_arcim_confirm_sie_kept', { count: 3, years: '2024, 2025, 2026' }))
      .toBe('Räkenskapsår 2024, 2025, 2026 är redan importerade och hämtas inte igen.')
  })
})

// #63: the source system's export carries its whole chart in #KONTO.
describe('OptionsStep: only the accounts the files use', () => {
  const unused = { unusedAccounts: [{ number: '2440', name: 'Leverantörsskulder' }, { number: '6110', name: 'Kontorsmateriel' }] }

  it.each([['sv', tSv], ['en', tEn]] as const)('offers the switch with the count of unused definitions (%s)', (locale, t) => {
    const html = render([file(2025), file(2026)], BASE_OPTIONS, locale, unused)
    expect(html).toContain(t('ext_arcim_option_only_used_accounts'))
    expect(html).toContain(t('ext_arcim_option_only_used_accounts_desc', { count: 2 }))
  })

  it('is on by default for a provider migration and survives the fetched years', () => {
    // A provider export is the provider's whole chart template.
    expect(DEFAULT_OPTIONS.onlyUsedAccounts).toBe(true)
    expect(optionsAfterSieData(DEFAULT_OPTIONS, SECOND_RUN).onlyUsedAccounts).toBe(true)
  })

  it('shows no switch when every definition is used', () => {
    const html = render([file(2025), file(2026)], BASE_OPTIONS, 'sv', { unusedAccounts: [] })
    expect(html).not.toContain(tSv('ext_arcim_option_only_used_accounts'))
  })
})
