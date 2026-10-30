/**
 * What the Bolaget overview says, one fact per register, from the answers
 * the register pages already read (GET /api/bolaget/share-register,
 * /api/bolaget/meetings, /api/commitments). Pure: the overview renders it,
 * the tests pin it. A register whose read failed or is closed is null, and
 * its line is left out rather than guessed.
 */
import { BOARD_MEMBER_ROLES, type CompanyRoleKind } from '@/lib/bolaget/types'
import { groupUpcomingPayments, type UpcomingPaymentLine } from '@/lib/commitments/register-view'
import type { AgreementView, ObligationView } from '@/lib/commitments/types'

export interface RegisterAnswer {
  register: {
    total_shares: number
    holders: readonly unknown[]
    reconciliation: { status: string; register_shares: number; settings_shares: number | null }
  }
  roles: {
    signatory_rule: string | null
    roles: ReadonlyArray<{ name: string; role: string; active: boolean }>
  }
}

export interface MeetingAnswer {
  meetings: ReadonlyArray<{ corporate_meeting_id: string; title: string; meeting_date: string; status: string }>
}

export interface CommitmentsAnswer {
  agreements: ReadonlyArray<Pick<AgreementView, 'status'>>
  upcoming_payments: readonly ObligationView[]
}

export interface OverviewFacts {
  owners: {
    holders: number
    shares: number
    /** 'all': the aktiebok holds every share the settings name; 'part': it holds fewer or more; null: the settings name none. */
    allocation: 'all' | 'part' | null
    register_shares: number
    settings_shares: number | null
  } | null
  board: { members: string[]; signatory_rule: string | null } | null
  next_meeting: { title: string; date: string } | 'none' | null
  payments: { next: UpcomingPaymentLine | null; others: number; missed: number } | null
  agreements: { active: number } | null
}

export function overviewFacts(input: {
  today: string
  register: RegisterAnswer | null
  meetings: MeetingAnswer | null
  commitments: CommitmentsAnswer | null
}): OverviewFacts {
  const { today, register, meetings, commitments } = input

  const owners: OverviewFacts['owners'] = register
    ? {
        holders: register.register.holders.length,
        shares: register.register.total_shares,
        allocation:
          register.register.reconciliation.status === 'match'
            ? 'all'
            : register.register.reconciliation.status === 'mismatch'
              ? 'part'
              : null,
        register_shares: register.register.reconciliation.register_shares,
        settings_shares: register.register.reconciliation.settings_shares,
      }
    : null

  const board: OverviewFacts['board'] = register
    ? {
        members: register.roles.roles
          .filter((r) => r.active && (BOARD_MEMBER_ROLES as readonly string[]).includes(r.role as CompanyRoleKind))
          .map((r) => r.name),
        signatory_rule: register.roles.signatory_rule,
      }
    : null

  let next_meeting: OverviewFacts['next_meeting'] = null
  if (meetings) {
    const planned = meetings.meetings
      .filter((m) => m.status === 'draft' && m.meeting_date >= today)
      .sort((a, b) => a.meeting_date.localeCompare(b.meeting_date) || a.corporate_meeting_id.localeCompare(b.corporate_meeting_id))
    next_meeting = planned[0] ? { title: planned[0].title, date: planned[0].meeting_date } : 'none'
  }

  let payments: OverviewFacts['payments'] = null
  let agreements: OverviewFacts['agreements'] = null
  if (commitments) {
    const lines = groupUpcomingPayments(commitments.upcoming_payments)
    const missed = lines.filter((l) => l.missed).length
    const upcoming = lines.filter((l) => !l.missed)
    payments = { next: upcoming[0] ?? null, others: Math.max(upcoming.length - 1, 0), missed }
    agreements = { active: commitments.agreements.filter((a) => a.status === 'active').length }
  }

  return { owners, board, next_meeting, payments, agreements }
}
