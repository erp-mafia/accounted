import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getEmailService } from '@/lib/email/service'
import { getBranding } from '@/lib/branding/service'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent-feedback-relay')

type AgentFeedback = EventPayload<'agent.feedback'>

/**
 * Where agent feedback is relayed: the support address the in-app support
 * form already writes to, where the desk turns each mail into a ticket. Off
 * unless AGENT_FEEDBACK_RELAY=true AND SUPPORT_RECIPIENT_EMAIL is set: the
 * branding default is Accounted's own address, so a self-hosted install that
 * set only the flag would otherwise mail its customers' reports to us.
 */
export function agentFeedbackRecipient(): string | null {
  if (process.env.AGENT_FEEDBACK_RELAY?.trim().toLowerCase() !== 'true') return null
  return process.env.SUPPORT_RECIPIENT_EMAIL?.trim() || null
}

/**
 * Worth a ticket: anything negative or neutral, and praise that carries a
 * suggestion. A bare "it worked" (a community upvote, say) is telemetry, and
 * a ticket for it would only be closed unanswered.
 */
export function isRelayWorthy(feedback: AgentFeedback): boolean {
  if (feedback.actorType === 'user') return false
  return feedback.sentiment !== 'positive' || !!feedback.suggestion?.trim()
}

/**
 * The relay speaks the in-app support form's format (/api/support/contact):
 * "Från:", "User ID:" and "Ämne:" lines that the desk reads as an app ticket,
 * with the reply going to the person, plus "Källa: agent-feedback" so the desk
 * labels it apart from what a person typed into the support dialog.
 */
export function composeAgentFeedbackMail(
  feedback: AgentFeedback,
  who: { email: string; companyName: string | null },
): { subject: string; text: string; html: string } {
  const company = who.companyName ?? feedback.companyId
  // The desk mails replies as "Re: <subject>", so this is what the customer
  // reads: plain words, not a tool name. The tool is in the body.
  const subject = `Din AI-agents rapport till Accounted (${company})`.slice(0, 180)
  const facts = [
    `Företag: ${company} (${feedback.companyId})`,
    `Verktyg: ${feedback.toolName ?? '-'} · Skill: ${feedback.skillSlug ?? '-'} · Sentiment: ${feedback.sentiment}`,
    `Klient: ${feedback.actorLabel ?? '-'} (${feedback.actorType})`,
    ...(feedback.sessionId ? [`Session: ${feedback.sessionId}`] : []),
  ]
  const when = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'long' })
  const body = [
    // The person did not write this, so a reply that just answers it reads
    // as unprompted. This line tells whoever answers to say where it came from.
    `Skickat ${when} av kundens AI-agent (${feedback.actorLabel ?? 'okänd klient'}) via feedbackverktyget, inte skrivet av personen själv. Börja svaret med att det gäller agentens rapport.`,
    '',
    feedback.context.trim(),
    ...(feedback.suggestion ? ['', 'Förslag:', feedback.suggestion.trim()] : []),
    '',
    '---',
    ...facts,
  ].join('\n')
  const text = `Från: ${who.email}\nUser ID: ${feedback.userId}\nÄmne: ${subject}\nKälla: agent-feedback\n\n${body}`
  const html = `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</pre>`
  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Every report an agent files through gnubok_feedback becomes a support
 * ticket, so it is read and answered instead of waiting for the weekly
 * event_log triage. The chat's thumbs-up/down (actorType 'user') carries no
 * text and stays telemetry, as does praise without a suggestion. Best effort: a failed relay is logged and the
 * report is still in event_log, where the weekly loop reads it.
 */
export function registerAgentFeedbackRelayHandler(): () => void {
  return eventBus.on('agent.feedback', relayAgentFeedback)
}

/** The agent.feedback handler; lib/init subscribes it through EVENT_CONSUMERS (lib/composition/event-consumers.ts). */
export async function relayAgentFeedback(feedback: AgentFeedback): Promise<void> {
  const to = agentFeedbackRecipient()
  if (!to || !isRelayWorthy(feedback)) return
  const email = await getEmailService()
  if (!email.isConfigured()) return
  try {
    const service = createServiceClientNoCookies()
    const [{ data: userData }, { data: company }] = await Promise.all([
      service.auth.admin.getUserById(feedback.userId),
      service.from('companies').select('name').eq('id', feedback.companyId).maybeSingle(),
    ])
    const from = userData?.user?.email
    if (!from) {
      log.warn('agent feedback not relayed: reporter has no email', { company: feedback.companyId })
      return
    }
    const mail = composeAgentFeedbackMail(feedback, { email: from, companyName: company?.name ?? null })
    const sent = await email.sendEmail({
      to,
      subject: `[${getBranding().appName.toLowerCase()} support] ${mail.subject}`,
      replyTo: from,
      text: mail.text,
      html: mail.html,
    })
    if (!sent.success) log.warn('agent feedback relay failed', { company: feedback.companyId, error: sent.error })
  } catch (err) {
    log.warn('agent feedback relay failed', { company: feedback.companyId, error: err instanceof Error ? err.message : String(err) })
  }
}
