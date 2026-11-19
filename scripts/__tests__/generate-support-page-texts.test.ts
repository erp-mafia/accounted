/**
 * The support assistant's page text index: which message keys a page and the
 * components it renders read. Checked on small sources held in memory, so the
 * rules are pinned without depending on which pages the app has today.
 */
import { describe, it, expect } from 'vitest'
import {
  analyseSource,
  buildPageTextIndex,
  expandKeyRef,
  isFollowed,
  resolveImport,
  routeOfPage,
  type SourceReader,
} from '../generate-support-page-texts'

function reader(files: Record<string, string>): SourceReader {
  return { read: (relative) => files[relative] ?? null }
}

const MESSAGES = {
  invoices: {
    title: 'Fakturor',
    new_invoice: 'Ny faktura',
    status_draft: 'Utkast',
    status_sent: 'Skickad',
    paid: 'Betald',
    unpaid: 'Obetald',
    nested: { hint: 'Skapas automatiskt' },
  },
  common: { save: 'Spara', cancel: 'Avbryt' },
  rot: { request_payout: 'Begär utbetalning' },
  top_level: 'Utan namnrymd',
}

describe('analyseSource', () => {
  it('reads the keys a client component takes from its translator, in source order', () => {
    const { refs } = analyseSource(
      'components/A.tsx',
      `'use client'
       import { useTranslations } from 'next-intl'
       export function A() {
         const t = useTranslations('invoices')
         return <button title={t('title')}>{t('new_invoice')}</button>
       }`,
    )
    expect(refs).toEqual([
      // A title on a button is its tooltip; the text inside it is the button.
      { path: 'invoices.title', prefix: false, role: 'd' },
      { path: 'invoices.new_invoice', prefix: false, role: 'b' },
    ])
  })

  it('follows awaited server translators, the object form and a Promise.all pair', () => {
    const { refs } = analyseSource(
      'app/(dashboard)/x/page.tsx',
      `import { getTranslations } from 'next-intl/server'
       export default async function Page() {
         const [t, tc] = await Promise.all([getTranslations('invoices'), getTranslations({ locale: 'sv', namespace: 'common' })])
         const bare = await getTranslations()
         return <div>{t('title')}{tc('save')}{bare('top_level')}</div>
       }`,
    )
    expect(refs.map((r) => r.path)).toEqual(['invoices.title', 'common.save', 'top_level'])
  })

  it('keeps two components in one file apart when both call their translator t', () => {
    const { refs } = analyseSource(
      'components/Two.tsx',
      `import { useTranslations } from 'next-intl'
       function One() { const t = useTranslations('invoices'); return <i>{t('title')}</i> }
       function Two() { const t = useTranslations('common'); return <i>{t('save')}</i> }`,
    )
    expect(refs.map((r) => r.path)).toEqual(['invoices.title', 'common.save'])
  })

  it('sees a translator from the enclosing component inside a callback, and the rich and has forms', () => {
    const { refs } = analyseSource(
      'components/Cb.tsx',
      `import { useTranslations } from 'next-intl'
       export function Cb({ rows }) {
         const t = useTranslations('invoices')
         return rows.map((row) => <i key={row.id}>{t.rich('nested.hint', {})}{t.has('paid') ? t('paid') : null}</i>)
       }`,
    )
    expect(refs.map((r) => r.path)).toEqual(['invoices.nested.hint', 'invoices.paid', 'invoices.paid'])
  })

  it('takes a template key as a prefix and both arms of a conditional key', () => {
    const { refs } = analyseSource(
      'components/Dyn.tsx',
      `import { useTranslations } from 'next-intl'
       export function Dyn({ s, done }) {
         const t = useTranslations('invoices')
         return <i>{t(\`status_\${s}\`)}{t(done ? 'paid' : 'unpaid')}{t(s)}</i>
       }`,
    )
    expect(refs).toEqual([
      { path: 'invoices.status_', prefix: true },
      { path: 'invoices.paid', prefix: false },
      { path: 'invoices.unpaid', prefix: false },
    ])
  })

  it('reads nothing through a function that is not a translator', () => {
    const { refs } = analyseSource(
      'components/No.tsx',
      `const t = (key: string) => key
       export const x = t('title')`,
    )
    expect(refs).toEqual([])
  })

  it('lists static, re-exported and dynamic imports, and leaves type-only ones out', () => {
    const { imports } = analyseSource(
      'components/Imp.tsx',
      `import { A } from './A'
       import type { B } from './B'
       import dynamic from 'next/dynamic'
       export { C } from '@/components/C'
       export type { D } from './D'
       const Lazy = dynamic(() => import('./Lazy'))`,
    )
    expect(imports).toEqual(['./A', 'next/dynamic', '@/components/C', './Lazy'])
  })
})

describe('analyseSource: keys read through a table of the file', () => {
  it('reads every text of a lookup table the translator is called with, as tabs when the table says so', () => {
    const { refs } = analyseSource(
      'app/(dashboard)/invoices/page.tsx',
      `import { useTranslations } from 'next-intl'
       const TAB_LABEL_KEYS: Record<string, string> = { all: 'tab_all', unpaid: 'tab_unpaid', nested: ['tab_overdue'] }
       const WIDTHS = { all: 'w-10' }
       export default function Page({ tab }) {
         const t = useTranslations('invoices')
         return <div className={WIDTHS[tab]}>{t(TAB_LABEL_KEYS[tab])}</div>
       }`,
    )
    expect(refs).toEqual([
      { path: 'invoices.tab_all', prefix: false, role: 't' },
      { path: 'invoices.tab_unpaid', prefix: false, role: 't' },
      { path: 'invoices.tab_overdue', prefix: false, role: 't' },
    ])
  })

  it('reads a table declared below the component, and one written with as const or satisfies', () => {
    const { refs } = analyseSource(
      'components/Below.tsx',
      `import { useTranslations } from 'next-intl'
       export function Below({ s }) { const t = useTranslations('invoices'); return <i>{t(STATUS_KEYS[s])}</i> }
       const STATUS_KEYS = { draft: 'status_draft', sent: 'status_sent' } as const satisfies Record<string, string>`,
    )
    expect(refs.map((r) => [r.path, r.role])).toEqual([
      ['invoices.status_draft', 's'],
      ['invoices.status_sent', 's'],
    ])
  })

  it('reads every value the file writes for a key property the translator is called with', () => {
    const { refs } = analyseSource(
      'components/Columns.tsx',
      `import { useTranslations } from 'next-intl'
       const COLUMNS = [{ id: 'a', headerKey: 'col_date' }, { id: 'b', headerKey: 'col_amount' }]
       export function Columns() {
         const t = useTranslations('invoices')
         return <tr>{COLUMNS.map((column) => <td key={column.id}>{t(column.headerKey)}</td>)}</tr>
       }`,
    )
    expect(refs.map((r) => [r.path, r.role])).toEqual([
      ['invoices.col_date', 'c'],
      ['invoices.col_amount', 'c'],
    ])
  })

  it('does not follow a bare variable or a table of another file', () => {
    const { refs, propertyReads } = analyseSource(
      'components/Bare.tsx',
      `import { useTranslations } from 'next-intl'
       import { REMOTE_KEYS } from './keys'
       const LOCAL = { a: 'title' }
       export function Bare({ key }) { const t = useTranslations('invoices'); return <i>{t(key)}{t(REMOTE_KEYS[key])}{t(LOCAL)}</i> }`,
    )
    expect(refs).toEqual([])
    expect(propertyReads).toEqual([])
  })

  it('reports a key property the file writes no value for, with the translator that reads it', () => {
    const { refs, propertyReads } = analyseSource(
      'components/Library.tsx',
      `import { useTranslations } from 'next-intl'
       import { getSections } from '@/lib/reports/catalog'
       export function Library() {
         const t = useTranslations('reports')
         return <ul>{getSections().map((item) => <li key={item.id}>{t(item.labelKey)}<h3>{t(item.titleKey)}</h3></li>)}</ul>
       }`,
    )
    expect(refs).toEqual([])
    expect(propertyReads).toEqual([
      { property: 'labelKey', namespace: 'reports' },
      { property: 'titleKey', namespace: 'reports', role: 'h' },
    ])
  })

  it('reports nothing for a key property the file writes itself', () => {
    const { propertyReads } = analyseSource(
      'components/Columns.tsx',
      `import { useTranslations } from 'next-intl'
       const COLUMNS = [{ headerKey: 'col_date' }]
       export function Columns() { const t = useTranslations('invoices'); return <b>{COLUMNS.map((c) => t(c.headerKey))}</b> }`,
    )
    expect(propertyReads).toEqual([])
  })
})

describe('analyseSource: what a text is on the page', () => {
  const roleOf = (jsx: string) =>
    analyseSource(
      'components/Role.tsx',
      `import { useTranslations } from 'next-intl'
       export function Role() { const t = useTranslations('invoices'); return ${jsx} }`,
    ).refs.map((r) => r.role)

  it('takes the role of the element the text is rendered in, up to three elements up', () => {
    expect(roleOf(`<Button><span>{t('new_invoice')}</span></Button>`)).toEqual(['b'])
    expect(roleOf(`<DialogTitle>{t('title')}</DialogTitle>`)).toEqual(['h'])
    expect(roleOf(`<Label htmlFor="x">{t('title')}</Label>`)).toEqual(['f'])
    expect(roleOf(`<th>{t('title')}</th>`)).toEqual(['c'])
    expect(roleOf(`<DropdownMenu.Item><b>{t('title')}</b></DropdownMenu.Item>`)).toEqual([undefined])
    expect(roleOf(`<DropdownMenuItem><b>{t('title')}</b></DropdownMenuItem>`)).toEqual(['m'])
    expect(roleOf(`<Button><a1><a2><a3>{t('title')}</a3></a2></a1></Button>`)).toEqual([undefined])
  })

  it('takes a prop of an element by the element, a placeholder and a help attribute by themselves', () => {
    expect(roleOf(`<PageHeader title={t('title')} description={t('nested.hint')} />`)).toEqual(['h', 'd'])
    expect(roleOf(`<SettingsRow label={t('title')} />`)).toEqual(['f'])
    expect(roleOf(`<input placeholder={t('title')} />`)).toEqual(['p'])
    expect(roleOf(`<SegmentedControl options={[{ value: 'a', label: t('paid') }]} aria-label={t('title')} />`)).toEqual(['t', undefined])
    expect(roleOf(`<Button title={t('title')} aria-label={t('paid')} />`)).toEqual(['d', 'b'])
  })

  it('gives no role to a text the source does not place', () => {
    expect(roleOf(`<div><p>{t('title')}</p></div>`)).toEqual([undefined])
    expect(analyseSource('lib/x.ts', `import { getTranslations } from 'next-intl/server'
      export async function x() { const t = await getTranslations('invoices'); return t('title') }`).refs).toEqual([
      { path: 'invoices.title', prefix: false },
    ])
  })
})

describe('expandKeyRef', () => {
  it('keeps an exact key only when it is a text in the message file', () => {
    expect(expandKeyRef({ path: 'invoices.title', prefix: false }, MESSAGES)).toEqual(['invoices.title'])
    expect(expandKeyRef({ path: 'invoices.missing', prefix: false }, MESSAGES)).toEqual([])
    expect(expandKeyRef({ path: 'invoices.nested', prefix: false }, MESSAGES)).toEqual([])
  })

  it('expands a prefix to every text beside it that starts the same way', () => {
    expect(expandKeyRef({ path: 'invoices.status_', prefix: true }, MESSAGES)).toEqual([
      'invoices.status_draft',
      'invoices.status_sent',
    ])
    expect(expandKeyRef({ path: 'nowhere.status_', prefix: true }, MESSAGES)).toEqual([])
  })
})

describe('resolveImport, routeOfPage, isFollowed', () => {
  const files = reader({
    'components/invoices/List.tsx': '',
    'components/invoices/index.ts': '',
    'lib/thing.ts': '',
  })

  it('resolves the alias, a relative path and a folder index, and nothing outside src', () => {
    expect(resolveImport('app/(dashboard)/invoices/page.tsx', '@/components/invoices/List', files)).toBe(
      'components/invoices/List.tsx',
    )
    expect(resolveImport('components/invoices/List.tsx', './index', files)).toBe('components/invoices/index.ts')
    expect(resolveImport('components/other/X.tsx', '../invoices', files)).toBe('components/invoices/index.ts')
    expect(resolveImport('components/invoices/List.tsx', 'react', files)).toBeNull()
    expect(resolveImport('components/invoices/List.tsx', '@/messages/sv.json', files)).toBeNull()
    expect(resolveImport('components/invoices/List.tsx', '@/tests/helpers', files)).toBeNull()
    expect(resolveImport('components/invoices/List.tsx', '../../../outside', files)).toBeNull()
  })

  it('names a page by its route, without route groups, and skips parallel and intercepted routes', () => {
    expect(routeOfPage('app/(dashboard)/invoices/[id]/page.tsx')).toBe('/invoices/[id]')
    expect(routeOfPage('app/(dashboard)/page.tsx')).toBe('/')
    expect(routeOfPage('app/(dashboard)/settings/(tabs)/company/page.tsx')).toBe('/settings/company')
    expect(routeOfPage('app/(dashboard)/x/@modal/page.tsx')).toBeNull()
    expect(routeOfPage('app/(dashboard)/x/(.)y/page.tsx')).toBeNull()
  })

  it('does not follow the generic controls, the chat, the support dialog or tests', () => {
    expect(isFollowed('components/invoices/List.tsx')).toBe(true)
    expect(isFollowed('components/ui/button.tsx')).toBe(false)
    expect(isFollowed('components/agent/AgentChat.tsx')).toBe(false)
    expect(isFollowed('components/support/SupportAsk.tsx')).toBe(false)
    expect(isFollowed('components/invoices/__tests__/x.test.tsx')).toBe(false)
  })
})

describe('buildPageTextIndex: a key property written in an imported module', () => {
  const messages = {
    reports: { title: 'Rapporter', name_result: 'Resultat', desc_result: 'Intäkter och kostnader', name_balance: 'Balans' },
    other: { name_result: 'Fel namnrymd' },
  }
  const index = buildPageTextIndex(
    ['app/(dashboard)/reports/page.tsx'],
    reader({
      'app/(dashboard)/reports/page.tsx': `
        import { Library } from '@/components/reports/Library'
        export default function Page() { return <Library /> }`,
      'components/reports/Library.tsx': `
        'use client'
        import { useTranslations } from 'next-intl'
        import { getSections } from '@/lib/reports/catalog'
        export function Library() {
          const t = useTranslations('reports')
          return <ul title={t('title')}>{getSections().map((item) => <li key={item.id}>{t(item.labelKey)}: {t(item.descKey)}</li>)}</ul>
        }`,
      // A plain module: it creates no translator, so it is no part of the
      // page, but the component that imports it reads its keys.
      'lib/reports/catalog.ts': `
        import { MORE } from '@/lib/reports/more'
        const ITEMS = [
          { id: 'result', labelKey: 'name_result', descKey: 'desc_result' },
          { id: 'balance', labelKey: 'name_balance', descKey: 'desc_missing' },
          { id: 'elsewhere', labelKey: 'name_unknown' },
        ]
        export function getSections() { return [...ITEMS, ...MORE] }`,
      'lib/reports/more.ts': `export const MORE = [{ id: 'far', labelKey: 'title' }]`,
    }),
    messages,
  )

  it('gives the reading component the keys that module writes for the property, in its own namespace', () => {
    const library = index.files.indexOf('components/reports/Library.tsx')
    expect(index.keys[library]).toEqual([
      'reports.title',
      'reports.name_result',
      'reports.name_balance',
      'reports.desc_result',
    ])
    // The module itself is no part of the page.
    expect(index.files).not.toContain('lib/reports/catalog.ts')
  })

  it('goes one step only: a module the imported module imports is not read', () => {
    const library = index.files.indexOf('components/reports/Library.tsx')
    // 'title' is written as a labelKey two steps away; the component has it only from its own t('title').
    expect(index.keys[library].filter((key) => key === 'reports.title')).toHaveLength(1)
    expect(index.roles?.[library]).toHaveLength(index.keys[library].length)
  })
})

describe('buildPageTextIndex', () => {
  const files = reader({
    'app/(dashboard)/invoices/page.tsx': `
      import { getTranslations } from 'next-intl/server'
      import { InvoiceList } from '@/components/invoices/InvoiceList'
      import { helper } from '@/lib/invoices/helper'
      export default async function Page() {
        const t = await getTranslations('invoices')
        return <InvoiceList title={t('title')} />
      }`,
    'app/(dashboard)/invoices/layout.tsx': `
      import { useTranslations } from 'next-intl'
      export default function Layout({ children }) { const t = useTranslations('common'); return <div title={t('cancel')}>{children}</div> }`,
    'app/(dashboard)/layout.tsx': `
      import { useTranslations } from 'next-intl'
      export default function Shell({ children }) { const t = useTranslations('common'); return <div title={t('save')}>{children}</div> }`,
    'components/invoices/InvoiceList.tsx': `
      'use client'
      import dynamic from 'next/dynamic'
      import { useTranslations } from 'next-intl'
      import { Button } from '@/components/ui/button'
      const RotDialog = dynamic(() => import('./RotDialog'))
      export function InvoiceList() { const t = useTranslations('invoices'); return <Button>{t('new_invoice')}</Button> }`,
    'components/invoices/RotDialog.tsx': `
      'use client'
      import { useTranslations } from 'next-intl'
      export default function RotDialog() { const t = useTranslations('rot'); return <b>{t('request_payout')}</b> }`,
    'components/ui/button.tsx': `
      import { useTranslations } from 'next-intl'
      export function Button() { const t = useTranslations('common'); return <button>{t('save')}</button> }`,
    'lib/invoices/helper.ts': `
      import { deep } from '@/lib/invoices/deep'
      export const helper = 1`,
    'lib/invoices/deep.ts': `
      import { getTranslations } from 'next-intl/server'
      export async function deep() { const t = await getTranslations('invoices'); return t('paid') }`,
    'app/(dashboard)/empty/page.tsx': `export default function Page() { return null }`,
  })
  const index = buildPageTextIndex(
    ['app/(dashboard)/invoices/page.tsx', 'app/(dashboard)/empty/page.tsx'],
    files,
    MESSAGES,
  )

  it('gives a page its own texts first, then its layout and what it renders, lazy dialogs included', () => {
    const positions = index.routes['/invoices']
    expect(positions.map((p) => index.files[p])).toEqual([
      'app/(dashboard)/invoices/page.tsx',
      'app/(dashboard)/invoices/layout.tsx',
      'components/invoices/InvoiceList.tsx',
      'components/invoices/RotDialog.tsx',
    ])
    expect(positions.map((p) => index.keys[p])).toEqual([
      ['invoices.title'],
      ['common.cancel'],
      ['invoices.new_invoice'],
      ['rot.request_payout'],
    ])
  })

  it('leaves out the shell layout, the generic controls and a plain module that creates no translator', () => {
    expect(index.files).not.toContain('app/(dashboard)/layout.tsx')
    expect(index.files).not.toContain('components/ui/button.tsx')
    // lib/invoices/helper.ts creates no translator, so it is a leaf: what it
    // imports is never reached.
    expect(index.files).not.toContain('lib/invoices/deep.ts')
  })

  it('has no entry for a page without texts, and keeps files, keys and roles in step', () => {
    expect(index.routes['/empty']).toBeUndefined()
    expect(index.files.length).toBe(index.keys.length)
    expect(index.roles?.length).toBe(index.keys.length)
    index.keys.forEach((keys, position) => expect(index.roles?.[position]).toHaveLength(keys.length))
  })

  it('records what each text is: the button in the list, nothing for the title the page hands on', () => {
    const list = index.files.indexOf('components/invoices/InvoiceList.tsx')
    expect(index.roles?.[list]).toBe('b')
    const page = index.files.indexOf('app/(dashboard)/invoices/page.tsx')
    expect(index.roles?.[page]).toBe('-')
  })
})
