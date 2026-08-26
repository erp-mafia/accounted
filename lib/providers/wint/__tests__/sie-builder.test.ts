import { describe, it, expect } from 'vitest';
import {
  buildWintSieFile,
  deriveIbByYear,
  accountDeltas,
  mapWintVoucherForSie,
  mapWintAccountForSie,
  type WintSieVoucher,
} from '../sie-builder';
import { parseSIEFile, validateSIEFile } from '@/lib/import/sie-parser';

const YEAR_2026 = { year: 2026, start: '2026-01-01', end: '2026-12-31' };
const YEAR_2025 = { year: 2025, start: '2025-01-01', end: '2025-12-31' };

function voucher(overrides: Partial<WintSieVoucher>): WintSieVoucher {
  return {
    seriesShortName: 'A',
    number: 1,
    bookingDate: '2026-02-15',
    text: 'Testverifikat',
    transactions: [],
    ...overrides,
  };
}

const SALES_VOUCHER = voucher({
  number: 1,
  text: 'Kundfaktura 1007',
  transactions: [
    { accountNumber: '1510', amount: 1250, text: 'Fordran' },
    { accountNumber: '2611', amount: -250 },
    { accountNumber: '3010', amount: -1000 },
  ],
});

const PAYMENT_VOUCHER = voucher({
  number: 2,
  bookingDate: '2026-03-01',
  text: 'Inbetalning "1007"',
  transactions: [
    { accountNumber: '1930', amount: 1250 },
    { accountNumber: '1510', amount: -1250 },
  ],
});

const BASE_OPTIONS = {
  companyName: 'Bolaget AB',
  orgNumber: '556699-0011',
  programVersion: '1.0',
  generatedDate: '2026-08-06',
  year: YEAR_2026,
  previousYear: YEAR_2025,
  accounts: [
    { accountNumber: '1510', name: 'Kundfordringar', sruCode: '7251' },
    { accountNumber: '1930', name: 'Företagskonto' },
    { accountNumber: '2611', name: 'Utgående moms 25%' },
    { accountNumber: '3010', name: 'Försäljning' },
  ],
  vouchers: [SALES_VOUCHER, PAYMENT_VOUCHER],
  ibByAccount: new Map([['1930', 50000]]),
};

describe('buildWintSieFile', () => {
  it('produces a SIE4 file our own parser accepts and validates', () => {
    const content = buildWintSieFile(BASE_OPTIONS);
    const parsed = parseSIEFile(content);
    const validation = validateSIEFile(parsed);

    expect(parsed.header.sieType).toBe(4);
    expect(parsed.header.companyName).toBe('Bolaget AB');
    expect(parsed.header.orgNumber).toBe('556699-0011');
    expect(parsed.vouchers).toHaveLength(2);
    expect(validation.errors).toEqual([]);
  });

  it('every rendered verification balances to zero', () => {
    const parsed = parseSIEFile(buildWintSieFile(BASE_OPTIONS));
    for (const ver of parsed.vouchers) {
      const sum = ver.lines.reduce((acc, t) => acc + t.amount, 0);
      expect(Math.round(sum * 100) / 100).toBe(0);
    }
  });

  it('renders IB/UB for balance accounts and RES for result accounts', () => {
    const content = buildWintSieFile(BASE_OPTIONS);

    // 1930: IB 50000 + payment 1250 = UB 51250
    expect(content).toContain('#IB 0 1930 50000.00');
    expect(content).toContain('#UB 0 1930 51250.00');
    // 1510: invoice +1250, payment -1250 -> IB 0/UB 0: omitted entirely
    expect(content).not.toContain('#IB 0 1510');
    // Result account: RES only, never IB
    expect(content).toContain('#RES 0 3010 -1000.00');
    expect(content).not.toContain('#IB 0 3010');
    // 2611 got no IB but has movement: UB must still appear
    expect(content).toContain('#UB 0 2611 -250.00');
  });

  it('excludes deleted vouchers from the ledger but documents them in a #PROSA record', () => {
    const content = buildWintSieFile({
      ...BASE_OPTIONS,
      vouchers: [
        SALES_VOUCHER,
        voucher({ number: 3, deleted: true, transactions: [{ accountNumber: '1930', amount: 1 }, { accountNumber: '1510', amount: -1 }] }),
        voucher({ number: 4, transactions: [] }),
      ],
    });
    const parsed = parseSIEFile(content);

    expect(parsed.vouchers).toHaveLength(1);
    expect(parsed.vouchers[0]?.number).toBe(1);
    // BFL 5 kap 6-7 §: the gap in the number series must be accounted for in
    // the file, not silently inherited.
    expect(content).toContain('#PROSA');
    expect(content).toContain('1 verifikat exkluderade (raderade i källsystemet WINT): A-3');
    // No #PROSA when nothing was deleted
    expect(buildWintSieFile(BASE_OPTIONS)).not.toContain('#PROSA');
  });

  it('refuses to render a transaction without an account number', () => {
    expect(() =>
      buildWintSieFile({
        ...BASE_OPTIONS,
        vouchers: [voucher({
          number: 9,
          transactions: [
            { accountNumber: '', amount: 100 },
            { accountNumber: '1930', amount: -100 },
          ],
        })],
      }),
    ).toThrow(/A-9.*without an account number/);
  });

  it('refuses to render a voucher without a booking date', () => {
    expect(() =>
      buildWintSieFile({
        ...BASE_OPTIONS,
        vouchers: [voucher({
          number: 9,
          bookingDate: '',
          transactions: [
            { accountNumber: '3010', amount: -100 },
            { accountNumber: '1930', amount: 100 },
          ],
        })],
      }),
    ).toThrow(/A-9.*no booking date/);
  });

  it('escapes quotes in voucher texts', () => {
    const parsed = parseSIEFile(buildWintSieFile(BASE_OPTIONS));
    const payment = parsed.vouchers.find((v) => v.number === 2);
    expect(payment?.description).toBe('Inbetalning "1007"');
  });

  it('emits declared #KONTO for every referenced account and orders vouchers per series', () => {
    const content = buildWintSieFile({
      ...BASE_OPTIONS,
      vouchers: [PAYMENT_VOUCHER, SALES_VOUCHER], // deliberately out of order
    });
    const parsed = parseSIEFile(content);

    expect(parsed.accounts.map((a) => a.number)).toEqual(['1510', '1930', '2611', '3010']);
    expect(parsed.vouchers.map((v) => v.number)).toEqual([1, 2]);
  });

  it('maps WINT dimensions to SIE reserved numbers (CostCenter=1, Project=6)', () => {
    const content = buildWintSieFile({
      ...BASE_OPTIONS,
      vouchers: [voucher({
        number: 1,
        transactions: [
          {
            accountNumber: '3010', amount: -100,
            dimensions: [
              { type: 'Project', shortName: 'P01', name: 'Projekt Alpha' },
              { type: 'Tag', shortName: 'ignoreme', name: 'Tag' },
            ],
          },
          { accountNumber: '1510', amount: 100 },
        ],
      })],
    });

    expect(content).toContain('#DIM 6 "Projekt"');
    expect(content).toContain('#OBJEKT 6 "P01" "Projekt Alpha"');
    expect(content).toContain('{6 "P01"}');
    expect(content).not.toContain('ignoreme');
  });
});

describe('deriveIbByYear', () => {
  it('walks opening balances backward from the anchor year', () => {
    // 2026 IB (anchor): 1930 = 51000. 2025 moved 1930 by +1000 and closed
    // result into 2099 (so the 2025 vouchers sum result accounts to zero).
    const vouchers2025 = [
      voucher({
        bookingDate: '2025-06-01',
        transactions: [
          { accountNumber: '1930', amount: 1000 },
          { accountNumber: '3010', amount: -1000 },
        ],
      }),
      voucher({
        number: 2,
        bookingDate: '2025-12-31',
        text: 'Årets resultat',
        transactions: [
          { accountNumber: '8999', amount: 1000 },
          { accountNumber: '2099', amount: -1000 },
        ],
      }),
    ];

    const ibByYear = deriveIbByYear(
      2026,
      new Map([['1930', 51000], ['2099', -1000]]),
      new Map([[2025, vouchers2025]]),
      [2025, 2026],
    );

    const ib2025 = ibByYear.get(2025)!;
    expect(ib2025.get('1930')).toBe(50000);
    // 2099 was built by 2025's closing: zero at the start of 2025 -> omitted
    expect(ib2025.has('2099')).toBe(false);
    // Result accounts never get IB
    expect(ib2025.has('3010')).toBe(false);
    expect(ibByYear.get(2026)!.get('1930')).toBe(51000);
  });

  it('stops at holes in the voucher chain instead of guessing', () => {
    const ibByYear = deriveIbByYear(2026, new Map([['1930', 100]]), new Map(), [2024, 2025, 2026]);
    expect(ibByYear.has(2026)).toBe(true);
    expect(ibByYear.has(2025)).toBe(false);
    expect(ibByYear.has(2024)).toBe(false);
  });
});

describe('raw WINT JSON mapping', () => {
  it('mapWintVoucherForSie stringifies integer account numbers and strips times', () => {
    const mapped = mapWintVoucherForSie({
      SeriesShortName: 'A',
      Number: 17,
      BookingDate: '2026-02-15T00:00:00',
      Text: 'Verifikat',
      Deleted: false,
      Transactions: [
        { AccountNumber: 1930, Amount: 100.005, Text: 'Bank', BookingDate: '2026-02-15T00:00:00', Dimensions: [] },
        { AccountNumber: 3010, Amount: -100.005 },
      ],
    });

    expect(mapped.number).toBe(17);
    expect(mapped.bookingDate).toBe('2026-02-15');
    expect(mapped.transactions[0]?.accountNumber).toBe('1930');
    expect(mapped.transactions[0]?.amount).toBe(100.01);
  });

  it('mapWintAccountForSie carries name, SRU and Ib', () => {
    const mapped = mapWintAccountForSie({ Number: 1930, Name: 'Företagskonto', SRU: 7281, Ib: 50000 });
    expect(mapped).toEqual({ accountNumber: '1930', name: 'Företagskonto', sruCode: '7281', ib: 50000 });
  });

  it('accountDeltas nets movements and skips deleted vouchers', () => {
    const deltas = accountDeltas([
      SALES_VOUCHER,
      PAYMENT_VOUCHER,
      voucher({ deleted: true, transactions: [{ accountNumber: '1930', amount: 9999 }] }),
    ]);
    expect(deltas.get('1510')).toBe(0);
    expect(deltas.get('1930')).toBe(1250);
    expect(deltas.get('3010')).toBe(-1000);
  });
});
