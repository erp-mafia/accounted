/**
 * WL-13 brand-mail snapshot suite: for every template class (invite, payslip,
 * invoice, reminder) assert the three sender states:
 *
 *   - branded company  -> brand sender + brand-domain links + no platform
 *                         ("Accounted") leakage in the mail body
 *   - unbranded company-> today's output, unchanged
 *   - unverified sender domain -> platform-address fallback (fromName set,
 *                         no fromAddress; the Resend service renders the brand
 *                         name alone over the platform address)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Brand } from '@/lib/branding/resolve'
import { makeCustomer, makeInvoice, makeCompanySettings } from '@/tests/helpers'

const resolveBrandForCompanyMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandForCompany: resolveBrandForCompanyMock,
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted', appUrl: 'https://app.gnubok.se' }),
}))

import { getSenderForCompany, getBaseUrlForBrand } from '../brand-sender'
import {
  generateInviteEmailSubject,
  generateInviteEmailHtml,
  generateInviteEmailText,
} from '../invite-templates'
import {
  generateReminderEmailHtml,
  generateReminderEmailText,
  type ReminderEmailData,
} from '../reminder-templates'
import { generateInvoiceEmailHtml } from '../invoice-templates'
import { buildPayslipLinkEmail } from '@/lib/salary/payslips/email-template'

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: 'brand-1',
    teamId: 'team-1',
    domain: 'app.siffra.se',
    appName: 'Siffra',
    logoUrl: null,
    brandColor: '#123456',
    chromeColor: null,
    fontKey: 'default',
    supportEmail: 'support@siffra.se',
    authEmailFrom: 'noreply@post.siffra.se',
    senderDomain: 'post.siffra.se',
    senderDomainStatus: 'verified',
    resendDomainId: 'rd-1',
    signupMode: 'open',
    ...overrides,
  }
}

const VERIFIED = makeBrand()
const UNVERIFIED = makeBrand({ senderDomainStatus: 'pending' })

beforeEach(() => {
  vi.clearAllMocks()
  resolveBrandForCompanyMock.mockResolvedValue(null)
})

describe('invite mail (template class: invite)', () => {
  async function composeInvite() {
    const sender = await getSenderForCompany('company-1')
    const baseUrl = getBaseUrlForBrand(sender.brand)
    const data = {
      companyName: 'Kund AB',
      inviterEmail: 'sara@siffra.se',
      inviteUrl: `${baseUrl}/invite/tok-1`,
      appName: sender.brand?.appName,
    }
    return {
      sender,
      subject: generateInviteEmailSubject(data),
      html: generateInviteEmailHtml(data),
      text: generateInviteEmailText(data),
    }
  }

  it('branded: brand sender, brand-domain link, no Accounted leakage', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(VERIFIED)
    const mail = await composeInvite()
    expect(mail.sender).toMatchObject({
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
      replyTo: 'support@siffra.se',
    })
    expect(mail.html).toContain('https://app.siffra.se/invite/tok-1')
    expect(mail.subject).toContain('siffra')
    expect(mail.html).not.toMatch(/accounted/i)
    expect(mail.text).not.toMatch(/accounted/i)
    expect(mail.html).toMatchSnapshot()
  })

  it('unbranded: byte-identical to the un-overridden template on the canonical URL', async () => {
    const mail = await composeInvite()
    expect(mail.sender).toEqual({ fromName: null, fromAddress: null, replyTo: null, brand: null })
    expect(mail.html).toContain('https://app.gnubok.se/invite/tok-1')
    const todays = generateInviteEmailHtml({
      companyName: 'Kund AB',
      inviterEmail: 'sara@siffra.se',
      inviteUrl: 'https://app.gnubok.se/invite/tok-1',
    })
    expect(mail.html).toBe(todays)
    expect(mail.html).toMatchSnapshot()
  })

  it('unverified sender domain: via-Accounted fallback (fromName without fromAddress)', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(UNVERIFIED)
    const mail = await composeInvite()
    expect(mail.sender.fromName).toBe('Siffra')
    expect(mail.sender.fromAddress).toBeNull()
    // Links and body still carry the brand even in the fallback.
    expect(mail.html).toContain('https://app.siffra.se/invite/tok-1')
    expect(mail.html).not.toMatch(/accounted/i)
  })
})

describe('payslip mail (template class: payslip)', () => {
  async function composePayslip() {
    const sender = await getSenderForCompany('company-1')
    const baseUrl = getBaseUrlForBrand(sender.brand)
    return {
      sender,
      ...buildPayslipLinkEmail({
        employeeFirstName: 'Anna',
        companyName: 'Kund AB',
        periodYear: 2026,
        periodMonth: 6,
        paymentDate: '2026-06-25',
        url: `${baseUrl}/payslip/tok-1`,
      }),
    }
  }

  it('branded: brand sender and brand-domain link', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(VERIFIED)
    const mail = await composePayslip()
    expect(mail.sender).toMatchObject({
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
    })
    expect(mail.html).toContain('https://app.siffra.se/payslip/tok-1')
    expect(mail.html).not.toMatch(/accounted/i)
    expect(mail.html).toMatchSnapshot()
  })

  it('unbranded: canonical link, platform sender, unchanged body', async () => {
    const mail = await composePayslip()
    expect(mail.sender.fromName).toBeNull()
    expect(mail.sender.fromAddress).toBeNull()
    expect(mail.html).toContain('https://app.gnubok.se/payslip/tok-1')
    expect(mail.html).toMatchSnapshot()
  })

  it('unverified sender domain: via-Accounted fallback', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(UNVERIFIED)
    const mail = await composePayslip()
    expect(mail.sender.fromName).toBe('Siffra')
    expect(mail.sender.fromAddress).toBeNull()
  })
})

describe('invoice mail (template class: invoice)', () => {
  const company = makeCompanySettings({
    company_name: 'Kund AB',
    org_number: '556000-0000',
  })
  const customer = makeCustomer({ name: 'Erik Andersson', email: 'erik@example.se', language: 'sv' })
  const invoice = makeInvoice({
    invoice_number: 'F-1001',
    invoice_date: '2026-07-01',
    due_date: '2026-07-31',
    total: 1250,
    currency: 'SEK',
  })

  it('branded: mail rides the brand sender domain, COMPANY stays the display sender', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(VERIFIED)
    const sender = await getSenderForCompany('company-1')
    // The call site (sendTrackedInvoiceEmail) keeps fromName = company name
    // and only picks up fromAddress from the brand.
    expect(sender.fromAddress).toBe('noreply@post.siffra.se')
    const html = generateInvoiceEmailHtml({ invoice, customer, company })
    // Template content is company-branded and platform-free by design;
    // the brand must not inject itself into the customer-facing body.
    expect(html).not.toMatch(/accounted/i)
    expect(html).not.toContain('Siffra')
    expect(html).toContain('Kund AB')
  })

  it('unbranded: template output unchanged and platform-free', async () => {
    const sender = await getSenderForCompany('company-1')
    expect(sender.fromAddress).toBeNull()
    const html = generateInvoiceEmailHtml({ invoice, customer, company })
    expect(html).not.toMatch(/accounted/i)
    expect(html).toMatchSnapshot()
  })

  it('unverified sender domain: no fromAddress, so the From header stays byte-identical', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(UNVERIFIED)
    const sender = await getSenderForCompany('company-1')
    expect(sender.fromAddress).toBeNull()
  })
})

describe('reminder mail (template class: reminder)', () => {
  function makeReminderData(actionUrl: string): ReminderEmailData {
    return {
      invoice: makeInvoice({
        invoice_number: 'F-1001',
        invoice_date: '2026-05-01',
        due_date: '2026-06-01',
        total: 1250,
        currency: 'SEK',
      }),
      customer: makeCustomer({ name: 'Erik Andersson', email: 'erik@example.se' }),
      company: makeCompanySettings({ company_name: 'Kund AB' }),
      reminderLevel: 1,
      daysOverdue: 20,
      actionUrl,
      interestAmount: 0,
      interestRate: 0,
      interestFromDate: '2026-06-02',
      interestDays: 0,
      reminderFee: 0,
    }
  }

  it('branded: action link on the brand home domain, no Accounted leakage', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(VERIFIED)
    const sender = await getSenderForCompany('company-1')
    const baseUrl = getBaseUrlForBrand(sender.brand)
    const data = makeReminderData(`${baseUrl}/invoice-action/tok-1`)
    const html = generateReminderEmailHtml(data)
    const text = generateReminderEmailText(data)
    expect(sender.fromAddress).toBe('noreply@post.siffra.se')
    expect(html).toContain('https://app.siffra.se/invoice-action/tok-1')
    expect(html).not.toMatch(/accounted/i)
    expect(text).toContain('https://app.siffra.se/invoice-action/tok-1')
  })

  it('unbranded: canonical action link and unchanged output', async () => {
    const sender = await getSenderForCompany('company-1')
    const baseUrl = getBaseUrlForBrand(sender.brand)
    const data = makeReminderData(`${baseUrl}/invoice-action/tok-1`)
    const html = generateReminderEmailHtml(data)
    expect(sender.fromAddress).toBeNull()
    expect(html).toContain('https://app.gnubok.se/invoice-action/tok-1')
    expect(html).not.toMatch(/accounted/i)
    expect(html).toMatchSnapshot()
  })

  it('unverified sender domain: brand link but platform From address', async () => {
    resolveBrandForCompanyMock.mockResolvedValue(UNVERIFIED)
    const sender = await getSenderForCompany('company-1')
    expect(sender.fromAddress).toBeNull()
    expect(getBaseUrlForBrand(sender.brand)).toBe('https://app.siffra.se')
  })
})
