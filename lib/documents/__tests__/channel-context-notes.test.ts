/**
 * renderChannelContextNotes: the one string WhatsApp chat context becomes on
 * its way into a verifikat description. Pins precedence (representation >
 * user_note > caption), the caption opt-in, the 220-char cap, and whole-name
 * participant truncation ("… och N till", never a name cut mid-way).
 */
import { describe, it, expect } from 'vitest'
import {
  renderChannelContextNotes,
  renderChannelParticipant,
  CHANNEL_CONTEXT_NOTES_MAX,
} from '../channel-context-notes'
import type { InboxChannelContext } from '@/types'

function repCtx(
  participants: { name: string; company: string | null }[],
  purpose: string | null = null,
  extra: Partial<InboxChannelContext> = {},
): InboxChannelContext {
  return {
    channel: 'whatsapp',
    representation: {
      participants,
      purpose,
      event_date: null,
      raw_answer: 'raw',
      answered_at: '2026-08-01T12:00:00Z',
    },
    ...extra,
  }
}

describe('renderChannelContextNotes', () => {
  it('renders a full representation answer: participants with company, then purpose', () => {
    const ctx = repCtx(
      [
        { name: 'Anna Berg', company: 'Volvo' },
        { name: 'Jakob W', company: null },
      ],
      'uppföljning av avtal',
    )
    expect(renderChannelContextNotes(ctx)).toBe(
      'Representation: Anna Berg (Volvo), Jakob W · Syfte: uppföljning av avtal',
    )
  })

  it('renders a self participant (no company) as the bare name', () => {
    expect(renderChannelParticipant({ name: ' Jakob W ', company: null })).toBe('Jakob W')
    expect(renderChannelParticipant({ name: 'Anna', company: '  ' })).toBe('Anna')
    const ctx = repCtx([{ name: 'Jakob W', company: null }], 'lunch med kund')
    expect(renderChannelContextNotes(ctx)).toBe(
      'Representation: Jakob W · Syfte: lunch med kund',
    )
  })

  it('renders purpose alone when the participant list is empty', () => {
    const ctx = repCtx([], 'kundmiddag')
    expect(renderChannelContextNotes(ctx)).toBe('Syfte: kundmiddag')
  })

  it('truncates the participant list by whole names with "… och N till"', () => {
    const participants = Array.from({ length: 12 }, (_, i) => ({
      name: `Deltagare Efternamnsson ${i + 1}`,
      company: 'Företagsnamnet Aktiebolag',
    }))
    const ctx = repCtx(participants, 'branschmässa i Göteborg')
    const line = renderChannelContextNotes(ctx)!

    expect(line.length).toBeLessThanOrEqual(CHANNEL_CONTEXT_NOTES_MAX)
    expect(line).toMatch(/… och \d+ till/)
    // Whole names only: every rendered participant appears in full or not at
    // all. The first is always kept; the last is always dropped here.
    expect(line).toContain('Deltagare Efternamnsson 1 (Företagsnamnet Aktiebolag)')
    expect(line).not.toContain('Deltagare Efternamnsson 12')
    // The dropped count accounts for every name not printed.
    const [, dropped] = line.match(/… och (\d+) till/)!
    const printed = participants.filter((p) => line.includes(`${p.name} (${p.company})`)).length
    expect(printed + Number(dropped)).toBe(participants.length)
    // No name was cut mid-way: the truncation marker follows a complete
    // "(company)" closing paren, not a partial name.
    expect(line).toMatch(/\(Företagsnamnet Aktiebolag\) … och \d+ till/)
    // Purpose survives truncation.
    expect(line).toContain('Syfte: branschmässa i Göteborg')
  })

  it('keeps at least one participant even when the line still overflows, then caps free text', () => {
    const ctx = repCtx(
      [
        { name: 'Anna Berg', company: 'Volvo' },
        { name: 'Bo Ek', company: null },
      ],
      'x'.repeat(400),
    )
    const line = renderChannelContextNotes(ctx)!
    expect(line.length).toBeLessThanOrEqual(CHANNEL_CONTEXT_NOTES_MAX)
    expect(line).toContain('Representation: Anna Berg (Volvo)')
    expect(line.endsWith('…')).toBe(true)
  })

  it('renders user_note alone', () => {
    const ctx: InboxChannelContext = {
      channel: 'whatsapp',
      user_note: 'Parkering vid kundbesök i Uppsala',
    }
    expect(renderChannelContextNotes(ctx)).toBe('Parkering vid kundbesök i Uppsala')
  })

  it('appends user_note after the representation answer', () => {
    const ctx = repCtx([{ name: 'Anna Berg', company: 'Volvo' }], 'avtalslunch', {
      user_note: 'Betald privat',
    })
    expect(renderChannelContextNotes(ctx)).toBe(
      'Representation: Anna Berg (Volvo) · Syfte: avtalslunch · Betald privat',
    )
  })

  it('falls back to the caption only when nothing else exists AND it was asked for', () => {
    const captionOnly: InboxChannelContext = {
      channel: 'whatsapp',
      caption: 'Kvitto taxi till kundmöte',
    }
    expect(renderChannelContextNotes(captionOnly, { includeCaption: true })).toBe(
      'Kvitto taxi till kundmöte',
    )

    // Caption is ignored the moment an explicit answer exists.
    const withNote: InboxChannelContext = {
      channel: 'whatsapp',
      caption: 'Kvitto taxi till kundmöte',
      user_note: 'Resa till Arlanda',
    }
    expect(renderChannelContextNotes(withNote, { includeCaption: true })).toBe('Resa till Arlanda')
  })

  // The caption is chat text nobody was asked for and nobody reviewed, while
  // every unattended caller (bulk-book, the routes' server-side defaults)
  // writes the result into an immutable verifikat. Opt-in, never default.
  it('leaves the caption out by default', () => {
    const captionOnly: InboxChannelContext = {
      channel: 'whatsapp',
      caption: 'kvittot från igår, Annas sjukbesök, hon betalade',
    }
    expect(renderChannelContextNotes(captionOnly)).toBeNull()
    expect(renderChannelContextNotes(captionOnly, {})).toBeNull()
    expect(renderChannelContextNotes(captionOnly, { includeCaption: false })).toBeNull()
  })

  it('renders the answered parts and drops the caption when captions are off', () => {
    const ctx = repCtx([{ name: 'Anna Berg', company: 'Volvo' }], 'avtalslunch', {
      caption: 'privat text som ingen granskat',
      user_note: 'Betald privat',
    })
    const line = renderChannelContextNotes(ctx)!
    expect(line).toBe('Representation: Anna Berg (Volvo) · Syfte: avtalslunch · Betald privat')
    expect(line).not.toContain('privat text som ingen granskat')
  })

  it('caps a runaway caption', () => {
    const ctx: InboxChannelContext = { channel: 'whatsapp', caption: 'k'.repeat(500) }
    const line = renderChannelContextNotes(ctx, { includeCaption: true })!
    expect(line.length).toBeLessThanOrEqual(CHANNEL_CONTEXT_NOTES_MAX)
    expect(line.endsWith('…')).toBe(true)
  })

  it('returns null for empty input', () => {
    expect(renderChannelContextNotes(null)).toBeNull()
    expect(renderChannelContextNotes(undefined)).toBeNull()
    expect(renderChannelContextNotes({ channel: 'whatsapp' })).toBeNull()
    expect(
      renderChannelContextNotes({
        channel: 'whatsapp',
        caption: 'ignorerad utan opt-in',
        user_note: '',
        representation: {
          participants: [{ name: '  ', company: null }],
          purpose: '  ',
          event_date: null,
          raw_answer: 'nej',
          answered_at: '2026-08-01T12:00:00Z',
        },
      }),
    ).toBeNull()
    expect(
      renderChannelContextNotes(
        {
          channel: 'whatsapp',
          caption: '   ',
          user_note: '',
          representation: {
            participants: [{ name: '  ', company: null }],
            purpose: '  ',
            event_date: null,
            raw_answer: 'nej',
            answered_at: '2026-08-01T12:00:00Z',
          },
        },
        { includeCaption: true },
      ),
    ).toBeNull()
  })

  it('is deterministic (same input, same output)', () => {
    const ctx = repCtx(
      [{ name: 'Anna Berg', company: 'Volvo' }],
      'uppföljning av avtal',
      { user_note: 'Kortköp' },
    )
    expect(renderChannelContextNotes(ctx)).toBe(renderChannelContextNotes(ctx))
  })
})
