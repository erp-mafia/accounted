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
      { path: 'invoices.title', prefix: false },
      { path: 'invoices.new_invoice', prefix: false },
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

  it('has no entry for a page without texts, and keeps files and keys in step', () => {
    expect(index.routes['/empty']).toBeUndefined()
    expect(index.files.length).toBe(index.keys.length)
  })
})
