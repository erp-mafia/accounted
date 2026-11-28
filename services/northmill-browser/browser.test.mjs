import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { BankPage } from './northmill.mjs'

const bank = 'https://www.northmill.com/se/foretag/app/portal/'
const csv = 'Kontonummer,123456\nSaldo,10\nKontohavare,Fixture AB\nOrg. Nr,556677-8899\nPeriod,2026-11-01 - 2026-11-28\n\nBokföringsdag,Beskrivning,Belopp,Saldo,Valuta\n2026-11-28,Fixture,10,10,SEK'

test('real Chromium: QR screen, allowed navigation, CSV download and company validation', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ acceptDownloads: true })
    await page.route('https://www.northmill.com/**', async route => {
      if (route.request().url().includes('/transactions')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button onclick="document.querySelector('#csv').hidden=false">Exportera</button><button>Betala</button><button id="csv" hidden>CSV/Excel</button><script>document.querySelector('#csv').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([${JSON.stringify(csv)}],{type:'text/csv'}));a.download='statement.csv';a.target='_blank';a.click()}</script>` })
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div data-testid="PortalLoginView_ScanStepQrCodeQrCodeImage" style="width:250px;height:250px;background:black"></div><button onclick="location.href='${bank}transactional/account/transactions?accountId=fixture'">Visa alla &amp; exportera</button><a href="${bank}transactional/account/pay-and-transfer">Betala</a><button data-testid="LoginCompanyPortalSelectCompanyView_Company0ListItem">Fixture AB 556677-8899</button><button data-testid="LoginCompanyPortalSelectCompanyView_Company1ListItem">Other AB 112233-4455</button>` })
    })
    await page.goto(`${bank}login`)
    const adapter = new BankPage(browser, page, '5566778899')
    const state = await adapter.status()
    assert.equal(state.state, 'login')
    assert(state.actions.some(action => action.label.includes('Fixture AB')))
    assert(!state.actions.some(action => /Other AB|Betala/.test(action.label)))
    const screen = await adapter.screen()
    assert.equal(screen.subarray(1, 4).toString(), 'PNG')
    await assert.rejects(adapter.action({ type: 'navigate', id: 'unknown' }), /BANK_LAYOUT_CHANGED/)
    const link = state.actions.find(action => action.label === 'Visa alla & exportera')
    await adapter.action({ type: 'navigate', id: link.id })
    await page.waitForURL('**/transactions?accountId=fixture')
    assert.equal((await adapter.status()).canExport, true)
    const file = await adapter.action({ type: 'export' })
    assert.equal(file.toString(), csv)
    adapter.organizationNumber = '1122334455'
    await assert.rejects(adapter.action({ type: 'export' }), /COMPANY_MISMATCH/)
    await assert.rejects(adapter.action({ type: 'export', url: 'https://evil.test' }), /INVALID_ACTION/)
  } finally { await browser.close() }
})
