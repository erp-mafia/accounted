import { beforeEach, describe, expect, it, vi } from 'vitest'

const mail = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn().mockResolvedValue(mail) }))

import { byraStatementsText, mailByraStatements } from '../byra-billing'
import { usageLine } from '../kinds'

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never

const result = {
  period: '2026-11',
  manual: [
    { companyId: 'c1', teamId: 't1', teamName: 'Byrån AB', lines: [usageLine('bank_account', 4), usageLine('signing', 5)] },
    { companyId: 'c2', teamId: 't1', teamName: 'Byrån AB', lines: [usageLine('peppol_send', 12)] },
    { companyId: 'c3', teamId: 't2', teamName: 'Siffran AB', lines: [usageLine('kivra_send', 2)] },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mail.isConfigured.mockReturnValue(true)
  mail.sendEmail.mockResolvedValue({ success: true })
})

describe('byraStatementsText', () => {
  it('sums each byrå and lists its clients\' lines under it', () => {
    const text = byraStatementsText(result)
    // 2 accounts x 20 kr + 2 signings x 10 kr + 2 e-invoices x 1 kr.
    expect(text).toContain('Byrån AB: 62,00 kr exkl. moms')
    expect(text).toContain('Siffran AB: 6,00 kr exkl. moms')
    expect(text).toContain('c1: Kopplade bankkonton, november 2026: 2 st à 20,00 kr = 40,00 kr')
    expect(text).toContain('c3: Utskick till Kivra, november 2026: 2 st à 3,00 kr = 6,00 kr')
  })
})

describe('mailByraStatements', () => {
  it('mails support once with the lines', async () => {
    expect(await mailByraStatements(result, log())).toBe(true)
    expect(mail.sendEmail).toHaveBeenCalledTimes(1)
    expect((mail.sendEmail.mock.calls[0]![0] as { subject: string }).subject).toContain('2026-11')
  })

  it('sends nothing when no byrå client has a line', async () => {
    expect(await mailByraStatements({ period: '2026-11', manual: [] }, log())).toBe(false)
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it('never throws when the mail fails: the statements stand', async () => {
    mail.sendEmail.mockRejectedValue(new Error('smtp down'))
    expect(await mailByraStatements(result, log())).toBe(false)
  })
})
