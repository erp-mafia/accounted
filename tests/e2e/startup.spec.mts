import { expect } from '@playwright/test'
import { test } from './fixtures'
import { BUDGET, withinBudget } from './budget'

// Measure the first authenticated request explicitly. Dependent projects then
// measure navigation with the server initialized and fresh browser contexts.
test('cold application request becomes data-ready within five seconds', async ({ page }, info) => {
  const { elapsed } = await withinBudget('Cold application startup', BUDGET.startup, async () => {
    const response = await page.goto('/customers', { waitUntil: 'domcontentloaded' })
    expect(response?.ok()).toBe(true)
    await page.getByRole('link', { name: 'Testkund 001 AB', exact: true }).waitFor({ state: 'visible' })
  })
  info.annotations.push({ type: 'duration', description: `Cold application startup: ${Math.round(elapsed)} ms / ${BUDGET.startup} ms` })
})
