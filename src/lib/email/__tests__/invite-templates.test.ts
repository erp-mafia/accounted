import { describe, it, expect } from 'vitest'
import { INVITE_TTL_HOURS } from '@/lib/auth/invite-ttl'
import {
  generateInviteEmailHtml,
  generateInviteEmailText,
  generateTeamInviteEmailHtml,
  generateTeamInviteEmailText,
} from '../invite-templates'

/**
 * The invitation mails tell the invitee how long the link works. That
 * sentence used to carry its own number ("7 dagar") in five places, so the
 * mail could promise more than `expires_at` granted. It now prints the
 * invitation lifetime itself.
 */
describe('invitation mails state the real link lifetime', () => {
  const company = {
    companyName: 'Kund AB',
    inviterEmail: 'sara@siffra.se',
    inviteUrl: 'https://app.example.test/invite/tok-1',
  }
  const team = {
    inviterEmail: 'sara@siffra.se',
    inviteUrl: 'https://app.example.test/invite/tok-1',
  }

  const mails: Array<[string, string]> = [
    ['company invite, html', generateInviteEmailHtml(company)],
    ['company invite, text', generateInviteEmailText(company)],
    ['team invite, html', generateTeamInviteEmailHtml(team)],
    ['team invite, text', generateTeamInviteEmailText(team)],
    ['branded team invite, html', generateTeamInviteEmailHtml({ ...team, appName: 'Siffra' })],
    ['branded team invite, text', generateTeamInviteEmailText({ ...team, appName: 'Siffra' })],
  ]

  it.each(mails)('%s', (_name, body) => {
    expect(body).toContain(`Länken är giltig i ${INVITE_TTL_HOURS} timmar.`)
    expect(body).not.toMatch(/giltig i \d+ dagar/)
  })

  it('says 24 timmar today', () => {
    expect(generateInviteEmailText(company)).toContain('Länken är giltig i 24 timmar.')
  })
})
