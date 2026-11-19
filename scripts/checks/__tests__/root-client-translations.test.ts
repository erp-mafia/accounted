/**
 * The root layout hands client components only ROOT_CLIENT_NAMESPACES. Proof
 * that every namespace client code on a root-served page reads is in that
 * list (a missing one renders raw keys in production), and that the scan
 * behind it follows the import graph the way Next.js renders it. Fixtures live
 * in an OS temp directory the test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT_CLIENT_NAMESPACES } from '@/i18n/root-client-namespaces'
import { findRootClientTranslations, FULL_CATALOG_PROVIDER } from '../root-client-translations.mjs'

interface Usage {
  file: string
  kind: 'namespace' | 'whole' | 'dynamic'
  namespace?: string
  call?: string
  chain: string[]
}

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-client-translations-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

const scan = (root: string) => findRootClientTranslations(root) as { routes: string[]; usages: Usage[] }
const reads = (usages: Usage[]) =>
  usages.map((u) => `${u.file}: ${u.kind === 'namespace' ? u.namespace : `${u.kind} ${u.call}`}`)

const PROVIDER = `import { NextIntlClientProvider } from 'next-intl'\nexport async function AllMessagesProvider({ children }) { return <NextIntlClientProvider>{children}</NextIntlClientProvider> }\n`

describe('root-client-translations scan', () => {
  it('records namespaces read by client code a public page renders, with the import chain', () => {
    const root = fixture({
      'app/layout.tsx': `import { Toaster } from '@/components/Toaster'\nexport default function L({ children }) { return <>{children}<Toaster /></> }\n`,
      'app/(public)/login/page.tsx': `import LoginForm from './login-form'\nexport default function Page() { return <LoginForm /> }\n`,
      'app/(public)/login/login-form.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nimport { Field } from '@/components/Field'\nexport default function LoginForm() { const t = useTranslations('auth'); return <Field label={t('email')} /> }\n`,
      'components/Field.tsx': `import { useTranslations } from 'next-intl'\nexport function Field() { const t = useTranslations('forms.field'); return t('x') }\n`,
      'components/Toaster.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport function Toaster() { const t = useTranslations("common"); return t('close') }\n`,
    })
    const { routes, usages } = scan(root)
    expect(routes).toEqual(['app/(public)/login/page.tsx', 'app/layout.tsx'])
    expect(reads(usages)).toEqual([
      'app/(public)/login/login-form.tsx: auth',
      'components/Field.tsx: forms.field',
      'components/Toaster.tsx: common',
    ])
    expect(usages.find((u) => u.file === 'components/Field.tsx')?.chain).toEqual([
      'app/(public)/login/page.tsx',
      'app/(public)/login/login-form.tsx',
      'components/Field.tsx',
    ])
  })

  it('skips server components, type-only imports and API routes', () => {
    const root = fixture({
      'app/(public)/privacy/page.tsx': `import { useTranslations } from 'next-intl'\nimport { Heading } from '@/components/Heading'\nimport type { Props } from '@/components/ClientOnlyTypes'\nexport default function Page() { const t = useTranslations('privacy'); return <Heading title={t('title')} /> }\n`,
      'components/Heading.tsx': `import { getTranslations } from 'next-intl/server'\nimport { useTranslations } from 'next-intl'\nexport function Heading() { const t = useTranslations('server_only'); return t('x') }\n`,
      'components/ClientOnlyTypes.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport type Props = {}\nexport function X() { return useTranslations('never')('x') }\n`,
      'app/api/hello/route.ts': `import { X } from '@/components/ClientOnlyTypes'\nexport const GET = () => X\n`,
    })
    const { routes, usages } = scan(root)
    expect(routes).toEqual(['app/(public)/privacy/page.tsx'])
    expect(usages).toEqual([])
  })

  it('follows literal dynamic imports (next/dynamic, React.lazy)', () => {
    const root = fixture({
      'app/invite/page.tsx': `'use client'\nimport dynamic from 'next/dynamic'\nconst Dialog = dynamic(() => import('@/components/InviteDialog'))\nexport default function Page() { return <Dialog /> }\n`,
      'components/InviteDialog.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport default function InviteDialog() { return useTranslations('invite')('title') }\n`,
    })
    expect(reads(scan(root).usages)).toEqual(['components/InviteDialog.tsx: invite'])
  })

  it('flags reads the root list cannot serve: the whole catalog or an unknown namespace', () => {
    const root = fixture({
      'app/error.tsx': `'use client'\nimport { useTranslations, useMessages } from 'next-intl'\nconst NS = 'errors'\nexport default function E() { const a = useTranslations(); const b = useTranslations(NS); const m = useMessages(); return a('x') + b('y') + Object.keys(m) }\n`,
    })
    expect(reads(scan(root).usages)).toEqual([
      'app/error.tsx: whole useMessages()',
      'app/error.tsx: whole useTranslations()',
      'app/error.tsx: dynamic useTranslations(NS)',
    ])
  })

  it('treats a layout that imports AllMessagesProvider as covering its whole subtree', () => {
    const root = fixture({
      [FULL_CATALOG_PROVIDER]: PROVIDER,
      'app/(dashboard)/layout.tsx': `import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'\nimport { Nav } from '@/components/Nav'\nexport default function L({ children }) { return <AllMessagesProvider><Nav />{children}</AllMessagesProvider> }\n`,
      'app/(dashboard)/loading.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport default function Loading() { return useTranslations('dashboard_loading')('x') }\n`,
      'app/(dashboard)/invoices/page.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport default function Page() { return useTranslations('invoices')('x') }\n`,
      'components/Nav.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport function Nav() { return useTranslations('nav')('x') }\n`,
      'app/(dashboard)-lookalike/page.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport default function Page() { return useTranslations('outside')('x') }\n`,
      'app/global-error.tsx': `'use client'\nimport { useTranslations } from 'next-intl'\nexport default function G() { return useTranslations('global')('x') }\n`,
    })
    const { routes, usages } = scan(root)
    expect(routes).toEqual(['app/(dashboard)-lookalike/page.tsx'])
    expect(reads(usages)).toEqual(['app/(dashboard)-lookalike/page.tsx: outside'])
  })
})

describe('ROOT_CLIENT_NAMESPACES', () => {
  const sourceRoot = path.resolve(__dirname, '../../../src')
  const { routes, usages } = scan(sourceRoot)
  const rootList: readonly string[] = ROOT_CLIENT_NAMESPACES
  const topLevel = (namespace: string) => namespace.split('.')[0]
  const describeUsage = (u: Usage) =>
    `${u.kind === 'namespace' ? u.namespace : u.call} (${u.chain.join(' > ')})`

  it('scans the root-served routes and none under a full-catalog layout', () => {
    expect(routes).toContain('app/layout.tsx')
    expect(routes).toContain('app/(auth)/login/page.tsx')
    expect(routes).toContain('app/(public)/invoice-action/[token]/page.tsx')
    const covered = routes.filter((r) =>
      ['app/(dashboard)/', 'app/(onboarding)/', 'app/companies/', 'app/sandbox/agenter/'].some((dir) =>
        r.startsWith(dir),
      ),
    )
    expect(covered).toEqual([])
  })

  it('holds every namespace client code on a root-served page reads', () => {
    const missing = usages
      .filter((u) => u.kind === 'namespace' && !rootList.includes(topLevel(u.namespace!)))
      .map(describeUsage)
    expect(missing).toEqual([])
  })

  it('is never asked for the whole catalog or an unknown namespace', () => {
    // useTranslations() / useMessages() would need every namespace, and
    // useTranslations(expr) one the scan cannot see: pass a literal namespace,
    // or move the page under a layout that renders AllMessagesProvider.
    expect(usages.filter((u) => u.kind !== 'namespace').map(describeUsage)).toEqual([])
  })

  it('names no namespace that root-served client code no longer reads', () => {
    const read = new Set(usages.filter((u) => u.namespace).map((u) => topLevel(u.namespace!)))
    expect(rootList.filter((namespace) => !read.has(namespace))).toEqual([])
  })

  it.each(['sv', 'en'])('names only namespaces that exist in messages/%s.json', (locale) => {
    const messages = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'messages', `${locale}.json`), 'utf8'),
    ) as Record<string, unknown>
    expect(rootList.filter((namespace) => !(namespace in messages))).toEqual([])
  })
})
