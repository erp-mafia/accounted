import { expect, type Page } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { root } from '../../scripts/e2e/runtime.mjs'
import path from 'node:path'
import { runtimeDir } from '../../scripts/e2e/runtime.mjs'
import { measured, BUDGET } from './budget'
import { test } from './fixtures'



const destinations: { path: string; ready: (page: Page) => Promise<unknown> }[] = [
  { path: '/customers', ready: page => page.getByRole('link', { name: 'Testkund 001 AB', exact: true }).waitFor({ state: 'visible' }) },
  { path: '/suppliers', ready: page => page.getByRole('link', { name: 'Testleverantor 001 AB', exact: true }).waitFor({ state: 'visible' }) },
  { path: '/articles', ready: page => page.getByRole('link', { name: 'Testtjanst 001', exact: true }).waitFor({ state: 'visible' }) },
  { path: '/invoices', ready: page => page.getByText(/E2E-C-\d+/).first().waitFor({ state: 'visible' }) },
  { path: '/supplier-invoices', ready: page => page.getByText(/E2E-S-\d+/).first().waitFor({ state: 'visible' }) },
  { path: '/bookkeeping', ready: page => page.locator('main tbody td').filter({ hasText: /^E2E / }).first().waitFor({ state: 'visible' }) },
  { path: '/chart-of-accounts', ready: page => page.getByRole('row').filter({ hasText: /\b[1-8]\d{3}\b/ }).first().waitFor({ state: 'visible' }) },
  { path: '/reports/huvudbok', ready: page => page.getByRole('table').or(page.getByRole('button', { name: /^Expandera konto / })).first().waitFor({ state: 'visible' }) },
  { path: '/reports/resultatrapport', ready: page => page.getByRole('row').filter({ hasText: '3011' }).first().waitFor({ state: 'visible' }) },
  { path: '/reports/balansrapport', ready: page => page.getByText(/SUMMA TILLGÅNGAR/i).first().waitFor({ state: 'visible' }) },
  { path: '/reports/trial-balance', ready: page => page.locator('main table tbody tr').first().waitFor({ state: 'visible' }) },
  { path: '/reports/grundbok', ready: page => page.locator('main table tbody tr').first().waitFor({ state: 'visible' }) },
  { path: '/reports/kundreskontra', ready: page => page.locator('main table tbody tr').first().waitFor({ state: 'visible' }) },
  { path: '/reports/supplier-ledger', ready: page => page.locator('main table tbody tr').first().waitFor({ state: 'visible' }) },
  { path: '/accounts', ready: page => page.getByText('Inga konton kopplade än.', { exact: false }).waitFor({ state: 'visible' }) },
  { path: '/salary', ready: page => page.getByRole('link', { name: 'Lägg till anställd', exact: true }).waitFor({ state: 'visible' }) },
  { path: '/settings/company', ready: page => expect(page.locator('input[name="company_name"]')).toHaveValue('E2E Ten Year Consulting AB') },
  { path: '/import', ready: page => expect(page.getByRole('button', { name: /^SIE-fil/ })).toBeEnabled() },
  { path: '/transactions', ready: async page => {
    await page.getByRole('tab', { name: 'Alla', exact: true }).click()
    await page.getByText(/^Synthetic bank transaction \d+$/).filter({ visible: true }).first().waitFor({ state: 'visible' })
  } },
]

for (const destination of destinations) {
  test(`ready within budget ${destination.path}`, async ({ page }, info) => {
    await measured(info, `Document navigation ${destination.path}`, BUDGET.navigation, async () => {
      const response = await page.goto(destination.path, { waitUntil: 'domcontentloaded' })
      expect(response?.ok()).toBe(true)
      await expect(page).toHaveURL(new RegExp(`${destination.path}(?:\\?|$)`))
      await destination.ready(page)
      if (info.project.name === 'mobile' && existsSync(path.join(root, 'src/components/ui/responsive-table.tsx'))) {
        const overflow = await page.locator('main').evaluate(main => ({
          outer: main.scrollWidth > main.clientWidth + 1,
          tables: [...main.querySelectorAll<HTMLElement>('div')].filter(element =>
            element.clientWidth > 0 && element.querySelector('table') &&
            ['auto', 'scroll'].includes(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 1,
          ).length,
        }))
        expect(overflow, 'Mobile data should fit without horizontal scrolling').toEqual({ outer: false, tables: 0 })
      }
    })
  })
}

test('supplier search and detail remain responsive with a full register', async ({ page }, info) => {
  await page.goto('/suppliers')
  await destinations[1].ready(page)
  await measured(info, 'Filter suppliers', BUDGET.interaction, async () => {
    await page.getByPlaceholder('Sök på namn, e-post eller org.nr...').fill('050')
    await page.getByRole('link', { name: 'Testleverantor 050 AB', exact: true }).waitFor({ state: 'visible' })
    await expect(page.getByRole('link', { name: 'Testleverantor 001 AB', exact: true })).toHaveCount(0)
  })
  await measured(info, 'Open supplier detail', BUDGET.navigation, async () => {
    await page.getByRole('link', { name: 'Testleverantor 050 AB', exact: true }).click()
    await page.getByRole('heading', { name: 'Testleverantor 050 AB', exact: true }).waitFor({ state: 'visible' })
    await page.getByText(/E2E-S-/).first().waitFor({ state: 'visible' })
  })
})

test('account search finds accounts beyond the first rendered page', async ({ page }, info) => {
  await page.goto('/chart-of-accounts')
  const search = page.getByPlaceholder('Sök konto (nummer eller namn)...')
  await expect(search).toBeEnabled()
  // The input is enabled before the initial chart request has completed.
  await destinations[6].ready(page)
  await measured(info, 'Search full chart', BUDGET.interaction, async () => {
    await search.fill('8999')
    await page.getByRole('row').filter({ hasText: '8999' }).waitFor({ state: 'visible' })
  })
})

test('authenticated client navigation can return to cached registers', async ({ page }, info) => {
  await page.goto('/customers')
  await destinations[0].ready(page)
  // Exercise the app's actual links and router cache rather than page.goto.
  // A link may live in the mobile menu, which has its own navigation layout.
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Öppna meny', exact: true }).click()
  }
  const link = page.getByRole('link', { name: 'Artiklar', exact: true })
  await expect(link).toBeVisible()
  await measured(info, 'Client navigation to articles', BUDGET.navigation, async () => {
    await link.click()
    await destinations[2].ready(page)
  })
  await measured(info, 'Back to cached customers', BUDGET.navigation, async () => {
    await page.goBack()
    await destinations[0].ready(page)
  })
})

test('journal entry details render before their background refresh within budget', async ({ page }, info) => {
  const response = await page.request.get('/api/bookkeeping/journal-entries?status=posted&limit=1&include_related=false')
  expect(response.ok()).toBe(true)
  const entry = (await response.json()).data[0]
  expect(entry.id).toBeTruthy()
  const detailRequests: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(`/api/bookkeeping/journal-entries/${entry.id}/`)) detailRequests.push(path)
  })
  let releaseRefresh!: () => void
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  await page.route(`**/api/bookkeeping/journal-entries/${entry.id}/detail`, async route => {
    await heldRefresh
    await route.continue()
  })
  const refreshed = page.waitForResponse(
    response => new URL(response.url()).pathname.endsWith(`/${entry.id}/detail`),
    { timeout: 15_000 },
  ).catch(() => null)
  const note = `E2E note before refresh ${info.project.name}`
  await page.route(`**/api/bookkeeping/journal-entries/${entry.id}/notes`, route => route.fulfill({ json: { data: {} } }))
  try {
    await measured(info, 'Open journal entry details', BUDGET.navigation, async () => {
      await page.goto(`/bookkeeping/${entry.id}`)
      await page.getByRole('heading', { name: 'Kontorader', exact: true }).waitFor({ state: 'visible' })
    })
    // Editing immediately must work even before SWR's background read has
    // populated its cache from the server-rendered seed.
    await page.getByRole('button', { name: 'Redigera anteckning', exact: true }).click()
    await page.getByPlaceholder('Intern anteckning...').fill(note)
    await measured(info, 'Save note before background refresh', BUDGET.interaction, async () => {
      await page.getByRole('button', { name: 'Spara', exact: true }).click()
      await expect(page.getByText(note, { exact: true })).toBeVisible()
    })
  } finally { releaseRefresh() }
  expect((await refreshed)?.ok()).toBe(true)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page.getByText(note, { exact: true })).toBeVisible()
  expect(detailRequests.filter(path => path.endsWith('/detail'))).toHaveLength(1)
  expect(detailRequests.filter(path => /\/(chain|references|retag-log|rattelse-log)$/.test(path))).toHaveLength(0)
})

test('voucher rows exist in server HTML without executing client JavaScript', async ({ page, browser }, info) => {
  const response = await page.request.get('/api/bookkeeping/journal-entries?status=posted&limit=1&include_related=false')
  expect(response.ok()).toBe(true)
  const entry = (await response.json()).data[0]
  const noJavaScript = await browser.newContext({ storageState: await page.context().storageState(), javaScriptEnabled: false, viewport: page.viewportSize() })
  try {
    const document = await noJavaScript.newPage()
    await measured(info, 'Server-render voucher rows', BUDGET.navigation, async () => {
      await document.goto(new URL(`/bookkeeping/${entry.id}`, response.url()).href)
      await expect(document.locator('table tbody tr').first()).toBeAttached()
    })
  } finally { await noJavaScript.close() }
})

test('failed reference reads recover both voucher links and referenced attachments', async ({ page }, info) => {
  const entries = await page.request.get('/api/bookkeeping/journal-entries?status=posted&limit=1&include_related=false')
  expect(entries.ok()).toBe(true)
  const entry = (await entries.json()).data[0]
  const suppliers = await page.request.get('/api/supplier-invoices?limit=1')
  expect(suppliers.ok()).toBe(true)
  const invoice = (await suppliers.json()).data[0]
  const documentId = 'edbe895e-cbc5-4b85-8f52-9c698d1b83e0'
  let retries = 0
  let documentReads = 0
  let releaseFirstRead!: () => void
  const firstReadHeld = new Promise<void>(resolve => { releaseFirstRead = resolve })
  let firstReadStarted!: () => void
  const firstReadRequested = new Promise<void>(resolve => { firstReadStarted = resolve })
  await page.route(`**/api/bookkeeping/journal-entries/${entry.id}/detail`, async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.references = null
    await route.fulfill({ response, json: body })
  })
  await page.route(`**/api/bookkeeping/journal-entries/${entry.id}/references`, async route => {
    retries++
    await firstReadRequested
    await route.fulfill({ json: { data: { references: [{ type: 'supplier_invoice', id: invoice.id, number: 'E2E-RECOVERED', document_id: documentId }] } } })
  })
  await page.route(`**/api/documents?journal_entry_id=${entry.id}&current_only=true`, async route => {
    const read = ++documentReads
    if (read === 1) { firstReadStarted(); await firstReadHeld }
    await route.fulfill({ json: { data: [] }, headers: { 'X-E2E-Document-Read': String(read) } })
  })
  await page.route(`**/api/documents/${documentId}`, route => route.fulfill({ json: { data: {
    id: documentId, file_name: 'recovered-source-document.pdf', file_size_bytes: 128,
    mime_type: 'application/pdf', storage_path: 'synthetic/recovered.pdf', created_at: '2026-01-01T00:00:00Z',
  } } }))
  await measured(info, 'Recover optional voucher references', BUDGET.navigation, async () => {
    await page.goto(`/bookkeeping/${entry.id}`)
    await page.getByRole('heading', { name: 'Kontorader', exact: true }).waitFor({ state: 'visible' })
    await page.locator(`a[href="/supplier-invoices/${invoice.id}"]`).filter({ hasText: 'E2E-RECOVERED' }).waitFor({ state: 'visible' })
    await page.getByText('recovered-source-document.pdf', { exact: true }).waitFor({ state: 'visible' })
    const olderRead = page.waitForResponse(response => response.headers()['x-e2e-document-read'] === '1')
    releaseFirstRead()
    await olderRead
    // Allow the late fetch and React update to settle before checking that
    // an earlier empty read cannot erase the recovered source document.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByText('recovered-source-document.pdf', { exact: true })).toBeVisible()
  })
  expect(retries).toBe(1)
})

test.describe('password login', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('opens the seeded company within budget', async ({ page }, info) => {
    const fixture = JSON.parse(readFileSync(path.join(runtimeDir, 'fixture.json'), 'utf8'))
    await page.goto('/login')
    await page.getByLabel(/E-post/i).fill(fixture.email)
    await page.getByLabel('Lösenord', { exact: true }).fill(fixture.password)
    await measured(info, 'Password login', BUDGET.navigation, async () => {
      await page.getByRole('button', { name: 'Logga in', exact: true }).click()
      await expect(page).not.toHaveURL(/\/login/)
      await expect(page.getByRole('main')).toBeVisible()
      await expect(page.locator('body')).toContainText('E2E Ten Year Consulting AB')
    })
  })
})
