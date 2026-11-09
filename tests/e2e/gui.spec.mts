import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { root, runtimeDir } from '../../scripts/e2e/runtime.mjs'
import { test } from './fixtures'
import { BUDGET, measured } from './budget'
import { horizontalOverflow } from './mobile-layout'
import { expect } from '@playwright/test'

test.skip(!existsSync(path.join(root, 'src/components/dashboard/NavTreeSection.tsx')), 'Companion UI PR is not present in this build')


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
    await page.locator('main table tbody tr').first().waitFor({ state: 'visible' })
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


test('whole ledger surfaces toggle once while links and selection stay independent', async ({ page }, info) => {
  await page.goto('/reports/huvudbok')
  const card = page.locator('main [data-expandable-surface]').first()
  const toggle = card.getByRole('button', { name: /^Expandera konto / })
  await expect(toggle).toBeVisible()
  const box = await card.boundingBox()
  expect(box).toBeTruthy()
  await measured(info, 'Expand a card through its padding', BUDGET.interaction, async () => {
    await card.click({ position: { x: box!.width - 8, y: box!.height - 8 } })
    await expect(card.getByRole('button', { name: /^Kollapsa konto / })).toBeVisible()
  })
  await card.getByText(/^IB:/).click()
  await expect(toggle).toBeVisible()
  await toggle.focus()
  await page.keyboard.press('Space')
  const collapse = card.getByRole('button', { name: /^Kollapsa konto / })
  await expect(collapse).toBeVisible()
  await card.evaluate(element => {
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(element.querySelector('h3')!)
    selection.removeAllRanges()
    selection.addRange(range)
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await expect(collapse).toBeVisible()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  if (info.project.name === 'mobile') {
    const fit = await card.locator('.responsive-table').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }))
    expect(fit.scroll).toBeLessThanOrEqual(fit.width + 1)
    const firstCell = card.locator('tbody tr').first().locator('td').first()
    expect(await firstCell.evaluate(element => getComputedStyle(element, '::before').content)).toContain('Ver.nr')
  }
})

test('back from a voucher restores expanded accounts, filters and scroll', async ({ page }, info) => {
  await page.goto('/reports/huvudbok')
  await page.getByRole('button', { name: 'Expandera alla', exact: true }).click()
  const link = page.locator('main .responsive-table a[href^="/bookkeeping/"]').last()
  await link.waitFor({ state: 'visible' })
  await link.scrollIntoViewIfNeeded()
  const card = link.locator('xpath=ancestor::*[@data-expandable-surface][1]')
  const disclosureLabel = await card.getByRole('button', { name: /^Kollapsa konto / }).getAttribute('aria-label')
  const before = await page.evaluate(() => ({ panel: document.getElementById('main-content')!.scrollTop, window: window.scrollY }))
  expect(Math.max(before.panel, before.window)).toBeGreaterThan(100)
  await link.click()
  await page.getByRole('heading', { name: 'Kontorader', exact: true }).waitFor({ state: 'visible' })
  await measured(info, 'Return to expanded ledger', BUDGET.navigation, async () => {
    await page.goBack()
    // One browser-side readiness check avoids measuring multiple full-DOM
    // trace snapshots as navigation time on a very long expanded ledger.
    await page.waitForFunction(({ expected, label }) => {
      const toggle = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button =>
        button.getAttribute('aria-label') === label && button.getAttribute('aria-expanded') === 'true' && button.getClientRects().length > 0,
      )
      return !!toggle && Math.max(
        Math.abs(document.getElementById('main-content')!.scrollTop - expected.panel), Math.abs(window.scrollY - expected.window),
      ) < 80
    }, { expected: before, label: disclosureLabel })
  })
  await expect(page.getByRole('checkbox', { name: 'Dölj inaktiva' })).toBeChecked()
})


for (const dimension of ['P1', null]) {
  test(`explicit account drill overrides a stored dimension with ${dimension ?? 'no dimension'}`, async ({ page }, info) => {
    const fixture = JSON.parse(readFileSync(path.join(runtimeDir, 'fixture.json'), 'utf8'))
    const key = `Accounted:view:${fixture.company}:/reports/huvudbok:report-dimension`
    await page.addInitScript(storageKey => sessionStorage.setItem(storageKey, JSON.stringify({ dimNo: '6', code: 'SAVED' })), key)
    const dimensions: (string | null)[] = []
    await page.route('**/api/reports/general-ledger?*', async route => {
      const url = new URL(route.request().url())
      dimensions.push(url.searchParams.get('dim_code'))
      // Use real fixture ledger rows while keeping this UI test independent
      // of whether the fake project is registered in the dimension catalog.
      url.searchParams.delete('dim_no')
      url.searchParams.delete('dim_code')
      const response = await page.request.get(url.toString())
      expect(response.ok()).toBe(true)
      await route.fulfill({ response })
    })
    await measured(info, 'Apply explicit account drill', BUDGET.navigation, async () => {
      await page.goto(`/reports/huvudbok?account=1930${dimension ? '&dim_no=6&dim_code=P1' : ''}`)
      await page.getByRole('button', { name: 'Kollapsa konto 1930', exact: true }).waitFor({ state: 'visible' })
    })
    expect(dimensions.length).toBeGreaterThan(0)
    expect(dimensions.every(value => value === dimension)).toBe(true)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`shared tables keep mobile rows distinct in ${theme} mode`, async ({ page }, info) => {
    await page.addInitScript(value => localStorage.setItem('theme', value), theme)
    const routes = ['/transactions', '/invoices', '/supplier-invoices', '/bookkeeping', '/reports/trial-balance', '/reports/grundbok', '/accounts']
    for (const route of routes) {
      let rowIndex = 0
      await measured(info, `Ready card table ${route}`, BUDGET.navigation, async () => {
        await page.goto(route)
        if (route === '/transactions') await page.getByRole('tab', { name: 'Alla', exact: true }).click()
        if (route === '/accounts') {
          // The isolated fixture has cash accounts, but no external bank link.
          await page.getByText('Inga konton kopplade än.', { exact: false }).waitFor({ state: 'visible' })
          return
        }
        // Playwright's custom :has(:nth-child()) query takes several seconds
        // on hundreds of rows. Native DOM selection keeps readiness timing
        // focused on the page while still checking the same visible data row.
        const found = await page.waitForFunction(() => {
          const rows = [...document.querySelectorAll('main .responsive-table > table > tbody > tr')]
          const index = rows.findIndex(row => row.children.length > 1 && row.getClientRects().length > 0)
          return index >= 0 ? index + 1 : false
        })
        rowIndex = Number(await found.jsonValue()) - 1
        await found.dispose()
      })
      expect(await page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(theme === 'dark')
      if (route === '/accounts') {
        const empty = page.locator('main .responsive-table tbody > tr').first()
        expect(await empty.evaluate(element => element.children.length)).toBe(1)
        expect(await empty.evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe('0px')
        continue
      }
      const row = page.locator('main .responsive-table > table > tbody > tr').nth(rowIndex)
      const layout = await row.evaluate(element => {
        const style = getComputedStyle(element)
        const wrapper = element.closest('.responsive-table') as HTMLElement
        const dataRows = [...element.parentElement!.children].filter(row => row.children.length > 1)
        const last = getComputedStyle(dataRows[dataRows.length - 1])
        return {
          narrow: wrapper.clientWidth <= 576,
          display: style.display,
          borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
          radius: style.borderTopLeftRadius,
          gap: parseFloat(getComputedStyle(element.parentElement!).rowGap),
          lastBottom: last.borderBottomWidth,
          cellBottoms: [...element.children].map(cell => getComputedStyle(cell).borderBottomWidth),
          overflow: wrapper.scrollWidth > wrapper.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
        }
      })
      expect(layout.overflow, route).toBe(false)
      if (layout.narrow) {
        expect(layout.display, route).toBe('grid')
        expect(layout.borders, route).toEqual(['1px', '1px', '1px', '1px'])
        expect(layout.radius, route).toBe('8px')
        expect(layout.gap, route).toBeGreaterThanOrEqual(12)
        expect(layout.lastBottom, route).toBe('1px')
        expect(layout.cellBottoms, route).toEqual(layout.cellBottoms.map(() => '0px'))
      } else {
        expect(layout.display, route).toBe('table-row')
        expect(layout.radius, route).toBe('0px')
      }
      if (route === '/supplier-invoices') {
        const checkbox = page.getByRole('checkbox', { name: 'Välj faktura för betalfil', exact: true }).first()
        // Resolve the displayed control before timing the tap: searching
        // hundreds of records is test-driver work, not UI response latency.
        const control = await checkbox.elementHandle()
        if (!control) throw new Error('Selectable invoice control is missing')
        await control.scrollIntoViewIfNeeded()
        // A far-down mobile card may still be entering after the table is
        // visible. Finish its bounded entrance animation before measuring
        // input response, rather than timing Playwright's stability retries.
        await control.evaluate(async element => {
          await Promise.all(element.closest('tr')!.getAnimations().map(animation => animation.finished))
        })
        try {
          // Complete hit testing and frame-stability checks before the input
          // clock. On CI, these driver checks take over a second even though
          // no pointer event has yet reached the app.
          await control.click({ trial: true })
          const box = await control.boundingBox()
          if (!box) throw new Error('Selectable invoice control is not visible')
          const x = box.x + box.width / 2
          const y = box.y + box.height / 2
          await measured(info, 'Select a supplier invoice without opening it', BUDGET.interaction, async () => {
            if (info.project.use.hasTouch) await page.touchscreen.tap(x, y)
            else await page.mouse.click(x, y)
            await page.waitForFunction(element => element.getAttribute('aria-checked') === 'true', control)
            expect(new URL(page.url()).pathname).toBe('/supplier-invoices')
          })
        } finally { await control.dispose() }
      }
      if (route === '/bookkeeping') {
        // Selection belongs to the row; the foldout must remain visually
        // connected to that row rather than appearing as a separate invoice.
        await row.locator('td').nth(3).click()
        const detail = page.locator('main tr[data-responsive-detail-row]').first()
        await detail.waitFor({ state: 'visible' })
        if (layout.narrow) {
          expect(await detail.evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe('1px')
          expect(await row.evaluate(element => getComputedStyle(element).borderBottomWidth)).toBe('0px')
        }
      }
    }
  })
}


test('forms, workflow steps and register toolbars fit narrow mobile widths', async ({ page }, info) => {
  const routes = [
    '/reports', '/chart-of-accounts', '/customers', '/suppliers', '/invoices/new', '/supplier-invoices?new=1',
    '/sales-orders/new', '/bookkeeping/year-end', '/rules', '/settings/security', '/reports/kassaflodesanalys', '/dpa',
  ]
  for (const route of routes) {
    await page.setViewportSize({ width: 390, height: 844 })
    await measured(info, `Ready narrow layout ${route}`, BUDGET.navigation, async () => {
      await page.goto(route)
      if (route === '/invoices/new') {
        await page.getByRole('combobox', { name: 'Ny fakturarad', exact: true }).waitFor({ state: 'visible' })
      } else if (['/chart-of-accounts', '/customers', '/suppliers'].includes(route)) {
        await page.waitForFunction(() => [...document.querySelectorAll('main tbody > tr')].some(row => row.children.length > 1 && row.getClientRects().length > 0))
      } else if (route === '/supplier-invoices?new=1') {
        await page.getByRole('dialog').waitFor({ state: 'visible' })
      } else if (route === '/bookkeeping/year-end') {
        await page.getByRole('tablist', { name: 'Bokslutets steg' }).waitFor({ state: 'visible' })
      } else if (route === '/reports/kassaflodesanalys') {
        await page.getByText('Årets kassaflöde', { exact: true }).waitFor({ state: 'visible' })
      } else if (route === '/dpa') {
        await page.getByRole('heading', { name: 'Personuppgiftsbiträdesavtal (DPA)', exact: true }).waitFor({ state: 'visible' })
      } else {
        await page.waitForFunction(() => {
          const main = document.querySelector('main')
          if (!main?.querySelector('h1') || main.querySelector('[aria-busy="true"]')) return false
          return main.querySelector('input, tbody tr, [role="tab"], section, form') !== null
        })
      }
    })
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 })
      const overflow = await page.evaluate(horizontalOverflow)
      expect(overflow, `${route} at ${width}px`).toEqual({ page: false, main: false, regions: [] })
    }
    if (route === '/invoices/new') {
      // Stacking keeps the original accessible input and editable entry row.
      const entry = page.getByRole('combobox', { name: 'Ny fakturarad', exact: true })
      await entry.focus()
      await expect(entry).toBeFocused()
      await expect(page.locator('.responsive-form-cell[data-label="Antal"]').first()).toBeVisible()
    }
  }
})

test('loaded customer, invoice and credit views fit narrow screens', async ({ page }, info) => {
  const customers = await page.request.get('/api/customers')
  expect(customers.ok()).toBe(true)
  const customer = (await customers.json()).data[0] as { id: string; name: string }
  const invoices = await page.request.get('/api/invoices?pageSize=2')
  expect(invoices.ok()).toBe(true)
  const invoice = (await invoices.json()).data[0] as { id: string; invoice_number: string }
  const routes = [`/customers/${customer.id}`, `/invoices/${invoice.id}`, `/invoices/${invoice.id}/credit`]
  for (const route of routes) {
    await page.setViewportSize({ width: 320, height: 844 })
    await measured(info, `Ready mobile detail ${route.split('/').slice(0, 2).join('/')}${route.endsWith('/credit') ? '/credit' : ''}`, BUDGET.navigation, async () => {
      await page.goto(route)
      if (route.startsWith('/customers/')) {
        await page.getByRole('heading', { name: customer.name, exact: true }).waitFor({ state: 'visible' })
      } else if (route.endsWith('/credit')) {
        await page.waitForFunction(() => [...document.querySelectorAll('main tbody > tr')].some(row => row.getClientRects().length > 0))
      } else {
        await page.locator('main h1').filter({ hasText: invoice.invoice_number }).waitFor({ state: 'visible' })
      }
    })
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await page.evaluate(horizontalOverflow), `Detail at ${width}px`).toEqual({ page: false, main: false, regions: [] })
    }
  }
})

test('mobile calendar weeks show seven readable days and retain day navigation', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await measured(info, 'Ready mobile calendar', BUDGET.navigation, async () => {
    await page.goto('/e/general/calendar')
    await page.getByRole('tab', { name: 'Vecka', exact: true }).waitFor({ state: 'visible' })
  })
  await page.getByRole('tab', { name: 'Vecka', exact: true }).click()
  const days = page.locator('[data-calendar-week-list] > button')
  await expect(days).toHaveCount(7)
  expect(await page.evaluate(horizontalOverflow)).toEqual({ page: false, main: false, regions: [] })
  const label = await days.first().locator('span').first().textContent()
  await measured(info, 'Open a mobile week day', BUDGET.interaction, async () => {
    await days.first().click()
    await page.getByRole('heading', { name: label!, exact: true, level: 2 }).waitFor({ state: 'visible' })
    await expect(page.getByRole('tab', { name: 'Dag', exact: true })).toHaveAttribute('aria-selected', 'true')
  })
  expect(await page.evaluate(horizontalOverflow)).toEqual({ page: false, main: false, regions: [] })
})
