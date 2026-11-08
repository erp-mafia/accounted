import { expect, type Page, type TestInfo } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runtimeDir } from '../../scripts/e2e/runtime.mjs'
import { withinBudget, BUDGET } from './budget'
import { test } from './fixtures'


async function measured(info: TestInfo, name: string, milliseconds: number, action: () => Promise<unknown>) {
  const { elapsed } = await withinBudget(name, milliseconds, action)
  info.annotations.push({ type: 'duration', description: `${name}: ${Math.round(elapsed)} ms / ${milliseconds} ms` })
}

const destinations: { path: string; ready: (page: Page) => Promise<unknown> }[] = [
  { path: '/customers', ready: page => page.getByRole('link', { name: 'Testkund 001 AB', exact: true }).waitFor({ state: 'visible' }) },
  { path: '/suppliers', ready: page => page.getByRole('link', { name: 'Testleverantor 001 AB', exact: true }).waitFor({ state: 'visible' }) },
  { path: '/articles', ready: page => page.getByRole('link', { name: 'Testtjanst 001', exact: true }).waitFor({ state: 'visible' }) },
  { path: '/invoices', ready: page => page.getByText(/E2E-C-\d+/).first().waitFor({ state: 'visible' }) },
  { path: '/supplier-invoices', ready: page => page.getByText(/E2E-S-\d+/).first().waitFor({ state: 'visible' }) },
  { path: '/bookkeeping', ready: page => page.getByRole('cell', { name: /^E2E / }).first().waitFor({ state: 'visible' }) },
  { path: '/chart-of-accounts', ready: page => page.getByRole('row').filter({ hasText: /\b[1-8]\d{3}\b/ }).first().waitFor({ state: 'visible' }) },
  { path: '/reports/huvudbok', ready: page => page.getByRole('button', { name: /^Expandera konto / }).first().waitFor({ state: 'visible' }) },
  { path: '/reports/resultatrapport', ready: page => page.getByRole('row').filter({ hasText: '3011' }).first().waitFor({ state: 'visible' }) },
  { path: '/reports/balansrapport', ready: page => page.getByText(/SUMMA TILLGÅNGAR/i).first().waitFor({ state: 'visible' }) },
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

test('general ledger collapses, expands and filters without another report fetch', async ({ page }, info) => {
  await page.goto('/reports/huvudbok')
  const accounts = page.getByRole('button', { name: /^Expandera konto / })
  await expect(accounts.first()).toBeVisible()
  const hideInactive = page.getByRole('checkbox', { name: 'Dölj inaktiva' })
  await expect(hideInactive).toBeChecked()
  await expect(page.getByRole('button', { name: /^Kollapsa konto / })).toHaveCount(0)
  const requests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/reports/general-ledger') requests.push(request.url())
  })
  await measured(info, 'Expand all ledger accounts', BUDGET.interaction, async () => {
    await page.getByRole('button', { name: 'Expandera alla', exact: true }).click()
    await page.getByRole('button', { name: /^Kollapsa konto / }).first().waitFor({ state: 'visible' })
    await page.getByRole('columnheader', { name: 'Ver.nr', exact: true }).first().waitFor({ state: 'visible' })
  })
  await measured(info, 'Collapse all ledger accounts', BUDGET.interaction, async () => {
    await page.getByRole('button', { name: 'Kollapsa alla', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Kollapsa konto / })).toHaveCount(0)
  })
  const activeCount = await accounts.count()
  await measured(info, 'Show inactive accounts', BUDGET.interaction, async () => {
    await hideInactive.uncheck()
    await expect(hideInactive).not.toBeChecked()
    await expect.poll(() => accounts.count(), { intervals: [16] }).toBeGreaterThan(activeCount)
  })
  expect(requests).toHaveLength(0)
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

test('menu disclosure opens nested reports without navigating', async ({ page }, info) => {
  await page.goto('/customers')
  await destinations[0].ready(page)
  const originalUrl = page.url()
  const mobile = info.project.name === 'mobile'
  if (mobile) await page.getByRole('button', { name: 'Öppna meny', exact: true }).click()
  const navigation = mobile
    ? page.getByRole('dialog', { name: 'Navigeringsmeny' })
    : page.getByRole('navigation', { name: 'Huvudnavigation' })
  const parentRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/reports') parentRequests.push(request.url())
  })
  if (!mobile) {
    await navigation.getByRole('button', { name: 'Expandera Inköp', exact: true }).click()
    await navigation.getByRole('link', { name: 'Leverantörer', exact: true }).waitFor({ state: 'visible' })
  }
  await measured(info, 'Expand report menu', BUDGET.interaction, async () => {
    await navigation.getByRole('button', { name: 'Expandera Rapporter', exact: true }).click()
    await navigation.getByRole('button', { name: 'Expandera Huvudböcker', exact: true }).waitFor({ state: 'visible' })
  })
  await measured(info, 'Expand nested report category', BUDGET.interaction, async () => {
    await navigation.getByRole('button', { name: 'Expandera Huvudböcker', exact: true }).click()
    await navigation.getByRole('link', { name: 'Huvudbok', exact: true }).waitFor({ state: 'visible' })
  })
  await expect(page).toHaveURL(originalUrl)
  expect(parentRequests).toHaveLength(0)
  const collapse = navigation.getByRole('button', { name: 'Fäll ihop Rapporter', exact: true })
  await collapse.focus()
  await page.keyboard.press('Space')
  await expect(navigation.getByRole('link', { name: 'Huvudbok', exact: true })).toBeHidden()
  await navigation.getByRole('button', { name: 'Expandera Rapporter', exact: true }).click()
  await measured(info, 'Navigate to a nested report', BUDGET.navigation, async () => {
    await navigation.getByRole('link', { name: 'Huvudbok', exact: true }).click()
    await expect(page).toHaveURL(/\/reports\/huvudbok$/)
    await destinations[7].ready(page)
  })
  if (mobile) {
    await expect(navigation).toBeHidden()
  } else {
    await expect(navigation.getByRole('link', { name: 'Huvudbok', exact: true })).toHaveAttribute('aria-current', 'page')
  }
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
