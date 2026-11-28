import { createHash } from 'node:crypto'
import { Refusal, MAX_DOWNLOAD, allowedBankUrl, validCsv } from './policy.mjs'

export const LOGIN_URL = 'https://www.northmill.com/se/foretag/app/portal/login'
const COMPANY_PREFIX = 'LoginCompanyPortalSelectCompanyView_'
const QR_ID = 'PortalLoginView_ScanStepQrCodeQrCodeImage'
const READ_LABEL = /^(?:Företagskonto(?:\s[\s\S]{0,140})?|Konton|Kontoöversikt|Transaktioner|Visa alla transaktioner|Visa transaktioner|Visa alla & exportera|Kontoutdrag)$/i
export function readOnlyLink(raw) {
  if (!allowedBankUrl(raw)) return false
  const url = new URL(raw)
  return /^\/se\/foretag\/app\/portal\/(?:feed|transactional\/accounts|transactional\/account-dashboard|transactional\/account\/transactions)\/?$/.test(url.pathname)
}

export class NorthmillAdapter {
  constructor(chromium) { this.chromium = chromium }
  async open(organizationNumber) {
    const browser = await this.chromium.launch({ headless: true })
    let stage = 'context'
    try {
      // Northmill's CloudFront rejects the default HeadlessChrome UA on preflight.
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 850 },
        userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
        locale: 'en-US', serviceWorkers: 'block' })
      await context.route('**/*', async route => {
        const req = route.request()
        if (req.isNavigationRequest() && req.resourceType() === 'document' && !allowedBankUrl(req.url())) return route.abort()
        return route.continue()
      })
      const page = await context.newPage()
      page.setDefaultTimeout(8000)
      page.on('dialog', dialog => { void dialog.dismiss() })
      context.on('page', popup => { if (popup !== page) void popup.close() })
      stage = 'portal'
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      stage = 'cookies'
      await page.getByRole('button', { name: 'Deny All Cookies', exact: true }).click({ timeout: 6000 }).catch(() => { /* An existing necessary-cookie choice has no consent dialog. */ })
      stage = 'login'
      await page.getByText('Mobilt BankID', { exact: true }).click({ timeout: 15_000 })
      stage = 'qr'
      await page.getByTestId(QR_ID).waitFor({ state: 'visible', timeout: 15_000 })
      return new BankPage(browser, page, organizationNumber)
    } catch (error) {
      console.warn('Northmill browser open failed', { stage, name: error.name })
      await browser.close(); throw error
    }
  }
}

/** Only published read navigation controls are exposed, never coordinates or scripts. */
export class BankPage {
  constructor(browser, page, organizationNumber) {
    this.browser = browser; this.page = page; this.organizationNumber = organizationNumber; this.actions = new Map()
  }
  async discover() {
    if (!allowedBankUrl(this.page.url())) throw new Refusal('BANK_ORIGIN_CHANGED', 502)
    this.actions.clear()
    const candidates = this.page.locator('a[href],button,[role="button"],[data-testid^="LoginCompanyPortalSelectCompanyView_Company"]')
    const count = await candidates.count()
    for (let index = 0; index < Math.min(count, 200); index++) {
      const locator = candidates.nth(index)
      if (!await locator.isVisible() || !await locator.isEnabled()) continue
      const label = (await locator.innerText()).trim().replace(/\s+/g, ' ')
      const href = await locator.getAttribute('href')
      const testId = await locator.getAttribute('data-testid') || ''
      const isCompany = /^LoginCompanyPortalSelectCompanyView_Company\d+ListItem$/.test(testId)
      const companyMatches = isCompany && label.replace(/\D/g, '').includes(this.organizationNumber)
      const companyContinue = testId === `${COMPANY_PREFIX}ShowModalButton`
      const readLink = href && readOnlyLink(new URL(href, this.page.url()).href)
      if (!(companyMatches || companyContinue || readLink || READ_LABEL.test(label))) continue
      const id = createHash('sha256').update(`${index}:${testId}:${href}:${label}`).digest('hex').slice(0, 24)
      this.actions.set(id, { locator, label: label.slice(0, 180) })
    }
    return [...this.actions].map(([id, { label }]) => ({ id, label }))
  }
  async status() {
    const actions = await this.discover()
    const qr = await this.page.getByTestId(QR_ID).isVisible()
    const canExport = /\/portal\/transactional\/account\/transactions\/?$/.test(new URL(this.page.url()).pathname) &&
      await this.page.getByText('Exportera', { exact: true }).isVisible().catch(() => false)
    return { state: qr || /\/portal\/login\/?$/.test(new URL(this.page.url()).pathname) ? 'login' : 'accounts', actions, canExport }
  }
  async screen() {
    if (!allowedBankUrl(this.page.url())) throw new Refusal('BANK_ORIGIN_CHANGED', 502)
    const qr = this.page.getByTestId(QR_ID)
    if (await qr.isVisible()) {
      return qr.screenshot({ type: 'png', animations: 'disabled', timeout: 5000 })
    }
    return this.page.screenshot({ type: 'png', animations: 'disabled', timeout: 5000 })
  }
  async action(input) {
    if (input.type === 'navigate' && typeof input.id === 'string' && Object.keys(input).length === 2) {
      await this.discover()
      const action = this.actions.get(input.id)
      if (!action) throw new Refusal('BANK_LAYOUT_CHANGED', 409)
      await action.locator.click()
      return null
    }
    if (input.type !== 'export' || Object.keys(input).length !== 1) throw new Refusal('INVALID_ACTION')
    if (!(await this.status()).canExport) throw new Refusal('BANK_LAYOUT_CHANGED', 409)
    await this.page.getByText('Exportera', { exact: true }).click()
    const csv = this.page.getByText('CSV/Excel', { exact: true })
    await csv.waitFor({ state: 'visible' })
    const downloadPromise = this.page.waitForEvent('download', { timeout: 20_000 })
    const [, download] = await Promise.all([csv.click(), downloadPromise])
    const stream = await download.createReadStream()
    if (!stream) throw new Refusal('DOWNLOAD_FAILED', 502)
    const chunks = []; let size = 0
    for await (const chunk of stream) {
      size += chunk.length
      if (size > MAX_DOWNLOAD) { stream.destroy(); throw new Refusal('FILE_TOO_LARGE', 413) }
      chunks.push(chunk)
    }
    const file = Buffer.concat(chunks)
    if (!validCsv(file)) throw new Refusal('INVALID_BANK_FILE', 422)
    const org = file.toString('utf8').split(/\r?\n/).slice(0, 10).find(line => /^"?Org\.?\s*Nr/i.test(line))
    if (!org || org.split(',').slice(1).join('').replace(/\D/g, '') !== this.organizationNumber) {
      throw new Refusal('COMPANY_MISMATCH', 409)
    }
    return file
  }
  async close() { await this.browser.close() }
}
