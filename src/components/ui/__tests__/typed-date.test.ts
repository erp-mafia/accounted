import { describe, expect, it } from 'vitest'
import {
  dateRangeIssue,
  dateTarget,
  liveTypedDate,
  parseTypedDate,
  retargetEvent,
  settleTypedDate,
  splitDateFieldClassName,
} from '../typed-date'

const TODAY = new Date(2026, 10, 20)

// crm#1954: a date is typed the way it is typed in Fortnox and Visma, and the
// field hands its caller YYYY-MM-DD.
describe('parseTypedDate', () => {
  it.each([
    ['2026-10-23', '2026-10-23'],
    ['20261023', '2026-10-23'],
    ['261023', '2026-10-23'],
    ['23/10', '2026-10-23'],
    ['5/1', '2026-01-05'],
    ['2026-1-5', '2026-01-05'],
    ['2026/10/23', '2026-10-23'],
    ['2026.10.23', '2026-10-23'],
    ['  2026-10-23 ', '2026-10-23'],
    ['2028-02-29', '2028-02-29'],
    ['280229', '2028-02-29'],
  ])('reads %s as %s', (text, expected) => {
    expect(parseTypedDate(text, TODAY)).toBe(expected)
  })

  it('takes the current year for a day and month', () => {
    expect(parseTypedDate('23/10', new Date(2027, 0, 2))).toBe('2027-10-23')
  })

  it('reads an empty field as no date', () => {
    expect(parseTypedDate('', TODAY)).toBe('')
    expect(parseTypedDate('   ', TODAY)).toBe('')
  })

  it.each([
    '2026-02-30',
    '20260230',
    '260230',
    '30/2',
    '2026-02-29',
    '2026-13-01',
    '23/13',
    '0/10',
    '2026-10',
    '2026',
    '2610',
    '26102',
    '2026-10-23x',
    '10/23/2026',
    '23.10',
    'abc',
    // The six-digit year a native Chromium date input lets through.
    '202610-10-23',
    // Outside the years the server accepts for a typed date.
    '1899-12-31',
    '2101-01-01',
  ])('rejects %s', (text) => {
    expect(parseTypedDate(text, TODAY)).toBeNull()
  })
})

describe('settleTypedDate: leaving the field', () => {
  it('normalises a typed date and hands it on', () => {
    expect(settleTypedDate('261023', '2026-10-01', TODAY)).toEqual({ date: '2026-10-23', text: '2026-10-23', invalid: false, emit: true })
  })

  it('stays quiet when the caller already has the date', () => {
    expect(settleTypedDate('20261023', '2026-10-23', TODAY)).toEqual({ date: '2026-10-23', text: '2026-10-23', invalid: false, emit: false })
  })

  it('keeps a text that is not a date on screen and clears the caller, so no other date is saved', () => {
    expect(settleTypedDate('2026-02-30', '2026-10-01', TODAY)).toEqual({ date: '', text: '2026-02-30', invalid: true, emit: true })
    expect(settleTypedDate('23/13', '', TODAY)).toEqual({ date: '', text: '23/13', invalid: true, emit: false })
  })

  it('lets the field be emptied', () => {
    expect(settleTypedDate('', '2026-10-01', TODAY)).toEqual({ date: '', text: '', invalid: false, emit: true })
  })
})

describe('liveTypedDate: while typing', () => {
  it('hands on a date as soon as the text reads as one, like a native date field', () => {
    expect(liveTypedDate('2026-10-2', '', TODAY)).toBe('2026-10-02')
    expect(liveTypedDate('2026-10-23', '2026-10-02', TODAY)).toBe('2026-10-23')
    expect(liveTypedDate('261023', '', TODAY)).toBe('2026-10-23')
  })

  it('says nothing for a half-typed text or a date the caller has', () => {
    expect(liveTypedDate('2026-10-', '2026-10-01', TODAY)).toBeNull()
    expect(liveTypedDate('261023', '2026-10-23', TODAY)).toBeNull()
  })

  it('does not misread an eight-digit date halfway', () => {
    const typed = ['2', '20', '202', '2026', '20261', '202610', '2026102'].map((t) => liveTypedDate(t, '', TODAY))
    expect(typed.every((d) => d === null)).toBe(true)
    expect(liveTypedDate('20261023', '', TODAY)).toBe('2026-10-23')
  })

  it('hands on an emptied field', () => {
    expect(liveTypedDate('', '2026-10-01', TODAY)).toBe('')
    expect(liveTypedDate('', '', TODAY)).toBeNull()
  })
})

describe('dateRangeIssue: min and max', () => {
  it('compares against ISO bounds', () => {
    expect(dateRangeIssue('2026-01-01', '2026-02-01', undefined)).toBe('early')
    expect(dateRangeIssue('2026-03-01', undefined, '2026-02-28')).toBe('late')
    expect(dateRangeIssue('2026-02-10', '2026-02-01', '2026-02-28')).toBeNull()
  })

  it('ignores bounds that are not dates', () => {
    expect(dateRangeIssue('2026-01-01', '', 5)).toBeNull()
  })
})

describe('dateTarget and retargetEvent: what the caller receives', () => {
  const node = {
    value: '261023',
    type: 'text',
    name: 'invoice_date',
    focus() {
      return this
    },
  }

  it('reads as the field with the settled date as its value', () => {
    const target = dateTarget(node, '2026-10-23')
    expect(target.value).toBe('2026-10-23')
    expect(target.name).toBe('invoice_date')
    expect(target.focus()).toBe(node)
  })

  it("hands react-hook-form's register() the date, not the half-typed text", () => {
    // register() re-reads the DOM value of a target that has a type, and takes
    // the event's value otherwise (react-hook-form createFormControl onChange).
    const registerReads = (target: { type?: string; value: string }, ref: { value: string }) => (target.type ? ref.value : target.value)
    expect(registerReads(dateTarget(node, '2026-10-23'), node)).toBe('2026-10-23')
    expect(registerReads(node, node)).toBe('261023')
  })

  it('keeps the event methods on the copy', () => {
    class FakeEvent {
      type = 'blur'
      defaultPrevented = false
      constructor(
        public target: object,
        public currentTarget: object
      ) {}
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    const source = new FakeEvent(node, node)
    const target = dateTarget(node, '2026-10-23')
    const copy = retargetEvent(source, 'change', target)
    expect(copy.type).toBe('change')
    expect(copy.target).toBe(target)
    expect(copy.currentTarget).toBe(target)
    copy.preventDefault()
    expect(copy.defaultPrevented).toBe(true)
    expect(source.type).toBe('blur')
  })
})

describe('splitDateFieldClassName', () => {
  it.each([
    ['h-8 w-[160px] tabular-nums', 'w-[160px]', 'h-8 tabular-nums'],
    ['w-full sm:w-48', 'w-full sm:w-48', ''],
    ['max-w-44 flex-none tabular-nums', 'max-w-44 flex-none', 'tabular-nums'],
    ['mt-1', 'mt-1', ''],
    ['h-8 w-fit px-2 py-0 text-sm tabular-nums', 'w-fit', 'h-8 px-2 py-0 text-sm tabular-nums'],
    ['h-9 tabular-nums prefill-settle', '', 'h-9 tabular-nums prefill-settle'],
    ['-mt-1 !w-40 md:max-w-[220px] date-figures', '-mt-1 !w-40 md:max-w-[220px]', 'date-figures'],
    ['inset-ring-1 inset-0 hidden sm:block', 'inset-0 hidden sm:block', 'inset-ring-1'],
  ])('splits %s', (className, box, field) => {
    expect(splitDateFieldClassName(className)).toEqual({ box, field })
  })

  it('takes no classes', () => {
    expect(splitDateFieldClassName(undefined)).toEqual({ box: '', field: '' })
  })
})
