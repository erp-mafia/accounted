import { ReminderChannelError, type ReminderChannel, type ReminderMessage } from '../channel'

/**
 * A channel that keeps what it was given instead of sending it: tests, and
 * the sandbox, where no reminder may reach a real address. `fail` makes the
 * next sends throw the given error.
 */
export interface FakeReminderChannel extends ReminderChannel {
  readonly sent: ReminderMessage[]
  fail(error: ReminderChannelError | null): void
}

export function createFakeReminderChannel(): FakeReminderChannel {
  const sent: ReminderMessage[] = []
  let failure: ReminderChannelError | null = null
  return {
    kind: 'email',
    sent,
    fail(error) {
      failure = error
    },
    async send(message) {
      if (failure) throw failure
      sent.push(message)
      return { provider: 'fake', providerMessageId: `fake-${sent.length}` }
    },
  }
}
