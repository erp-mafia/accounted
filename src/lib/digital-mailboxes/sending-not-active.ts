/**
 * The refusal of a send through Kivra or Billo while the company's sending
 * there is not active (DIGITAL_MAILBOX_SENDING_NOT_ACTIVE), saying where it
 * stands (details.state, sendingStateOf) and what that leaves to do:
 *
 *  - off: nobody switched sending on, or it was switched off. A company
 *    admin switches it on under Inställningar › Kopplingar.
 *  - pending: sending is switched on and waits for the provider to accept
 *    Accounted's access request (the company already sends through it via
 *    another service). Nothing to do but wait: the cron asks the provider and
 *    switches sending on when it accepts.
 *  - rejected: the provider declined the request. Switching sending on again
 *    asks once more (activateSending makes a new request); otherwise Accounted
 *    helps.
 *
 * The invoice send and the payslip send refuse with the same answer.
 */
import type { StructuredErrorRemediation } from '@/lib/errors/structured-errors'
import { senderRequestOf, type DigitalMailboxConnection } from './connections'
import { DIGITAL_MAILBOX_PROVIDER_NAMES, sendingStateOf, type DigitalMailboxSendingState } from './sending-status'
import type { DigitalMailboxProviderId } from './types'

export type SendingNotActiveState = Exclude<DigitalMailboxSendingState, 'active'>

export interface SendingNotActiveRefusal {
  code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE'
  details: { state: SendingNotActiveState }
  messageSv: string
  messageEn: string
  remediation: StructuredErrorRemediation
}

const SWITCH_SV = 'Utskick av fakturor och lönebesked'

/** Where the switch is, in the app's own words. */
const switchPath = (name: string) => `Inställningar › Kopplingar › ${name} › ${SWITCH_SV}`

function texts(state: SendingNotActiveState, name: string): Omit<SendingNotActiveRefusal, 'code' | 'details'> {
  switch (state) {
    case 'pending':
      return {
        messageSv:
          `Utskick via ${name} är påslaget men väntar på att ${name} godkänner det: företaget skickar redan via ${name} genom en annan tjänst, och vi har bett om att Accounted också får skicka. ` +
          `Utskicken startar av sig själva när ${name} har godkänt, det brukar gå fort under kontorstid. Skicka med e-post så länge.`,
        messageEn:
          `Sending through ${name} is switched on and waits for ${name} to approve it: the company already sends through ${name} via another service, and we have asked for Accounted to send too. ` +
          `Sending starts by itself once ${name} approves, usually quickly during office hours. Send by email meanwhile.`,
        remediation: {
          description:
            `details.state pending: sending is switched on and waits for ${name} to accept Accounted's access request (the company already sends through ${name} via another service). ` +
            'Nothing to do but wait: Accounted asks the provider on a schedule and switches sending on when it accepts. Do not retry in a loop; send by email meanwhile (channel email) if it cannot wait.',
        },
      }
    case 'rejected':
      return {
        messageSv:
          `${name} nekade att Accounted skickar för företaget, eftersom företaget redan skickar via ${name} genom en annan tjänst. ` +
          `Slå på utskicken igen under ${switchPath(name)} för att fråga på nytt, eller kontakta oss så hjälper vi till. Skicka med e-post så länge.`,
        messageEn:
          `${name} declined to let Accounted send for the company, since the company already sends through ${name} via another service. ` +
          `Switch sending on again under ${switchPath(name)} to ask once more, or contact us and we will help. Send by email meanwhile.`,
        remediation: {
          description:
            `details.state rejected: ${name} declined Accounted's access request. A company admin can switch "${SWITCH_SV}" on again under Settings, Connections (/settings/connections), which asks ${name} once more, or contact Accounted for help; an agent or API key cannot. ` +
            'Until then send by email: channel email, the default.',
        },
      }
    case 'off':
      return {
        messageSv:
          `Utskick via ${name} är inte påslaget för företaget. En administratör slår på det under ${switchPath(name)}. Skicka med e-post så länge.`,
        messageEn:
          `Sending through ${name} is not switched on for the company. An admin switches it on under ${switchPath(name)}. Send by email meanwhile.`,
        remediation: {
          description:
            `details.state off: sending through ${name} is not switched on. A company admin switches on "${SWITCH_SV}" for ${name} under Settings, Connections (/settings/connections); an agent or API key cannot. ` +
            'Until then send by email: channel email, the default.',
        },
      }
  }
}

/**
 * Whether the company sends through the provider: sending switched on, with
 * the sender (tenant) the provider gave. Everything that sends asks this.
 */
export function isActiveSender<C extends Pick<DigitalMailboxConnection, 'send_state' | 'tenant_ref'>>(
  connection: C | null,
): connection is C & { send_state: 'active'; tenant_ref: string } {
  return connection?.send_state === 'active' && !!connection.tenant_ref
}

/**
 * The refusal of a send while the company does not send through `provider`
 * (isActiveSender is false), naming where its sending stands. An active row
 * without its tenant cannot send either and reads as off: switching sending
 * on again registers the sender.
 */
export function sendingNotActiveRefusal(
  provider: DigitalMailboxProviderId,
  connection: Pick<DigitalMailboxConnection, 'send_state' | 'provider_meta'> | null,
): SendingNotActiveRefusal {
  const read = sendingStateOf(
    connection ? { send_state: connection.send_state, send_request: senderRequestOf(connection)?.status ?? null } : null,
  )
  const state: SendingNotActiveState = read === 'active' ? 'off' : read
  return {
    code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE',
    details: { state },
    ...texts(state, DIGITAL_MAILBOX_PROVIDER_NAMES[provider]),
  }
}
