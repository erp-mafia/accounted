import { existsSync } from 'node:fs'
import path from 'node:path'
import { root } from '../../scripts/e2e/runtime.mjs'
import { test } from './fixtures'
import { BUDGET, withinBudget } from './budget'
import { expect, type TestInfo } from '@playwright/test'

test.skip(!existsSync(path.join(root, 'src/components/dashboard/NavTreeSection.tsx')), 'Companion UI PR is not present in this build')

async function measured(info: TestInfo, name: string, limit: number, action: () => Promise<unknown>) {
  const result = await withinBudget(name, limit, action)
  info.annotations.push({ type: 'latency', description: `${name}: ${Math.round(result.elapsed)} ms / ${limit} ms` })
}

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

test('menu disclosure opens nested reports without navigating', async ({ page }, info) => {
  await page.goto('/customers')
  await page.getByRole('link', { name: 'Testkund 001 AB', exact: true }).waitFor({ state: 'visible' })
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
    await page.getByRole('button', { name: /^Expandera konto / }).first().waitFor({ state: 'visible' })
  })
  if (mobile) {
    await expect(navigation).toBeHidden()
  } else {
    await expect(navigation.getByRole('link', { name: 'Huvudbok', exact: true })).toHaveAttribute('aria-current', 'page')
  }
})

test('statutory report navigation keeps its dedicated section', async ({ page }, info) => {
  await page.goto('/reports/vat-declaration')
  const mobile = info.project.name === 'mobile'
  if (mobile) await page.getByRole('button', { name: 'Öppna meny', exact: true }).click()
  const navigation = mobile
    ? page.getByRole('dialog', { name: 'Navigeringsmeny' })
    : page.getByRole('navigation', { name: 'Huvudnavigation' })
  const toggle = navigation.getByRole('button', { name: 'Expandera Rapporter', exact: true })
  await toggle.waitFor({ state: 'visible' })
  const panelId = await toggle.getAttribute('aria-controls')
  await toggle.click()
  const reports = navigation.locator(`[id="${panelId}"]`)
  await expect(reports.locator('a[href="/reports/vat-declaration"]')).toHaveCount(0)
  await expect(reports.locator('a[href="/reports/ink2-declaration"]')).toHaveCount(0)
  await expect(reports.locator('a[href="/reports/ne-declaration"]')).toHaveCount(0)
  await expect(reports.locator('a[href="/reports/huvudbok"]')).toHaveCount(1)
  if (!mobile) await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1)
})


test('ledger account headers fit the viewport and retain full names', async ({ page }, info) => {
  await page.goto('/reports/huvudbok')
  await page.getByRole('button', { name: /^Expandera konto / }).first().waitFor({ state: 'visible' })
  const titles = page.locator('h3[data-ph-mask]')
  const lengths = await titles.evaluateAll(nodes => nodes.map(node => node.textContent?.length ?? 0))
  const longest = titles.nth(lengths.indexOf(Math.max(...lengths)))
  const dimensions = await longest.evaluate(element => ({
    width: element.clientWidth, scrollWidth: element.scrollWidth,
    right: element.getBoundingClientRect().right, viewport: window.innerWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1)
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport)
  if (info.project.name === 'mobile') {
    const header = longest.locator('xpath=../..')
    await expect(header.locator('svg:visible')).toHaveCount(0)
    await expect(longest.getByRole('button', { name: /^Expandera konto / })).toBeVisible()
    await longest.getByRole('button', { name: /^Expandera konto / }).click()
    await expect(longest.getByRole('button', { name: /^Kollapsa konto / })).toHaveAttribute('aria-expanded', 'true')
  }
})
