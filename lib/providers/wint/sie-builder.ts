/**
 * Render a SIE 4E file from WINT voucher + account data.
 *
 * WINT's partner-facing v1 API has no SIE export (that endpoint lives in
 * their internal Full spec, which we deliberately do not call: Tier A). The
 * v1 surface does expose the complete ledger (/api/Voucher with transactions,
 * /api/Account with names/SRU/IB), which is everything a SIE 4E file carries,
 * so we render the file ourselves and feed it to the provider-agnostic SIE
 * import pipeline (parse -> validate -> map accounts -> import).
 *
 * Format authority: SIE 4B spec (record-types reference in the
 * swedish-sie-import-export skill). Invariants honored here:
 * - every #VER's #TRANS amounts sum to 0.00 (source is double-entry; we
 *   never adjust amounts, only round to 2 decimals)
 * - debit positive / credit negative (WINT transaction amounts are already
 *   signed this way: a voucher's Transactions sum to zero)
 * - #IB only for balance-sheet accounts (1xxx-2xxx); #RES for result accounts
 * - vouchers ascending by number within each series
 */

import { isBalanceSheetAccount } from '@/lib/import/sie-parser';

export interface WintSieTransaction {
  /** Integer in WINT's JSON; stringified at the mapping boundary. */
  accountNumber: string;
  accountName?: string;
  amount: number;
  text?: string;
  bookingDate?: string;
  dimensions?: { type: string; shortName?: string; name?: string; id?: string }[];
}

export interface WintSieVoucher {
  seriesShortName: string;
  number: number;
  bookingDate: string;
  text?: string;
  deleted?: boolean;
  transactions: WintSieTransaction[];
}

export interface WintSieAccount {
  accountNumber: string;
  name: string;
  sruCode?: string;
  /** Opening balance for WINT's CURRENT financial year (see deriveIbByYear). */
  ib?: number;
}

export interface WintSieYear {
  /** Calendar year the fiscal year starts in (SIE #RAR is date-ranged; this keys maps). */
  year: number;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

export interface BuildWintSieOptions {
  companyName: string;
  orgNumber?: string;
  programVersion: string;
  /** Generation date, YYYY-MM-DD (passed in: keeps the builder pure/testable). */
  generatedDate: string;
  year: WintSieYear;
  previousYear?: WintSieYear;
  accounts: WintSieAccount[];
  /** Vouchers belonging to `year` only. Deleted vouchers are skipped. */
  vouchers: WintSieVoucher[];
  /** Opening balances for `year`, per account number (balance accounts only). */
  ibByAccount: Map<string, number>;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Raw /api/Voucher item (PascalCase, IncludeTransactions=true) -> builder shape. */
export function mapWintVoucherForSie(raw: Record<string, unknown>): WintSieVoucher {
  const transactions = ((raw['Transactions'] as Record<string, unknown>[] | undefined) ?? []).map(
    (t): WintSieTransaction => ({
      // Integer in WINT's JSON: stringified here, never used numerically again.
      accountNumber: t['AccountNumber'] != null ? String(t['AccountNumber']) : '',
      accountName: t['AccountName'] as string | undefined,
      amount: round2(Number(t['Amount'] ?? 0)),
      text: (t['Text'] as string | undefined) || undefined,
      bookingDate: (t['BookingDate'] as string | undefined)?.slice(0, 10),
      dimensions: ((t['Dimensions'] as Record<string, unknown>[] | undefined) ?? []).map((d) => ({
        type: (d['Type'] as string) ?? '',
        shortName: d['ShortName'] as string | undefined,
        name: d['Name'] as string | undefined,
        id: d['Id'] != null ? String(d['Id']) : undefined,
      })),
    }),
  );

  return {
    seriesShortName: (raw['SeriesShortName'] as string) || 'A',
    number: Number(raw['Number'] ?? 0),
    bookingDate: ((raw['BookingDate'] as string) ?? '').slice(0, 10),
    text: (raw['Text'] as string | undefined) || undefined,
    deleted: raw['Deleted'] === true,
    transactions,
  };
}

/** Raw /api/Account item -> builder shape (Ib anchors to WINT's current FY). */
export function mapWintAccountForSie(raw: Record<string, unknown>): WintSieAccount {
  return {
    accountNumber: raw['Number'] != null ? String(raw['Number']) : '',
    name: (raw['Name'] as string) ?? '',
    sruCode: raw['SRU'] != null && raw['SRU'] !== 0 ? String(raw['SRU']) : undefined,
    ib: raw['Ib'] != null ? round2(Number(raw['Ib'])) : undefined,
  };
}

function fmtAmount(value: number): string {
  return round2(value).toFixed(2);
}

function fmtDate(isoDate: string): string {
  return isoDate.slice(0, 10).replaceAll('-', '');
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

/**
 * WINT dimension types -> SIE reserved dimension numbers. Only the reserved
 * numbers with an exact semantic match are emitted; everything else is
 * dropped rather than guessed into the wrong dimension.
 */
const SIE_DIMENSIONS: Record<string, number> = {
  CostCenter: 1,
  Project: 6,
  Employee: 7,
  Customer: 8,
  Supplier: 9,
};

const SIE_DIMENSION_NAMES: Record<number, string> = {
  1: 'Kostnadsställe',
  6: 'Projekt',
  7: 'Anställd',
  8: 'Kund',
  9: 'Leverantör',
};

interface DimensionRef {
  dimNo: number;
  objectNo: string;
  objectName: string;
}

function sieDimensionRefs(t: WintSieTransaction): DimensionRef[] {
  const refs: DimensionRef[] = [];
  for (const d of t.dimensions ?? []) {
    const dimNo = SIE_DIMENSIONS[d.type];
    const objectNo = (d.shortName || d.id || '').trim();
    if (!dimNo || !objectNo) continue;
    refs.push({ dimNo, objectNo, objectName: d.name || objectNo });
  }
  return refs;
}

/**
 * Net movement per account over a set of vouchers (deleted ones excluded).
 * Used both for #RES/#UB rendering and for walking IB between years.
 */
export function accountDeltas(vouchers: WintSieVoucher[]): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const voucher of vouchers) {
    if (voucher.deleted) continue;
    for (const t of voucher.transactions) {
      deltas.set(t.accountNumber, round2((deltas.get(t.accountNumber) ?? 0) + t.amount));
    }
  }
  return deltas;
}

/**
 * WINT's /api/Account Ib anchors to the company's CURRENT financial year.
 * Earlier imported years derive their opening balances by walking backward:
 * IB(y) = IB(y+1) - delta(y) for balance-sheet accounts. The walk is
 * deterministic because the voucher lists include the year-end closing
 * vouchers WINT posted (which zero the result accounts into equity), exactly
 * as they would appear in a native SIE export.
 *
 * `vouchersByYear` must cover every year between the earliest requested year
 * and the anchor year, else the chain has a hole and the missing years are
 * simply not returned (callers surface those years as failed rather than
 * importing a ledger with broken IB/UB continuity).
 */
export function deriveIbByYear(
  anchorYear: number,
  anchorIb: Map<string, number>,
  vouchersByYear: Map<number, WintSieVoucher[]>,
  wantedYears: number[],
): Map<number, Map<string, number>> {
  const result = new Map<number, Map<string, number>>();
  result.set(anchorYear, anchorIb);

  const earliest = Math.min(...wantedYears, anchorYear);
  let current = anchorIb;
  for (let y = anchorYear - 1; y >= earliest; y--) {
    const vouchers = vouchersByYear.get(y);
    if (!vouchers) break; // hole in the chain: stop deriving
    const deltas = accountDeltas(vouchers);
    const ib = new Map<string, number>();
    const accounts = new Set([...current.keys(), ...deltas.keys()]);
    for (const account of accounts) {
      if (!isBalanceSheetAccount(account)) continue;
      const value = round2((current.get(account) ?? 0) - (deltas.get(account) ?? 0));
      if (value !== 0) ib.set(account, value);
    }
    result.set(y, ib);
    current = ib;
  }

  // Forward walk covers wanted years after the anchor (unusual, but a company
  // whose current WINT year is not the latest imported year must still get
  // correct opening balances): IB(y+1) = IB(y) + delta(y).
  current = anchorIb;
  const latest = Math.max(...wantedYears, anchorYear);
  for (let y = anchorYear + 1; y <= latest; y++) {
    const prevVouchers = vouchersByYear.get(y - 1);
    if (!prevVouchers) break;
    const deltas = accountDeltas(prevVouchers);
    const ib = new Map<string, number>();
    const accounts = new Set([...current.keys(), ...deltas.keys()]);
    for (const account of accounts) {
      if (!isBalanceSheetAccount(account)) continue;
      const value = round2((current.get(account) ?? 0) + (deltas.get(account) ?? 0));
      if (value !== 0) ib.set(account, value);
    }
    result.set(y, ib);
    current = ib;
  }

  return result;
}

export function buildWintSieFile(options: BuildWintSieOptions): string {
  const {
    companyName, orgNumber, programVersion, generatedDate,
    year, previousYear, accounts, vouchers, ibByAccount,
  } = options;

  const active = vouchers.filter((v) => !v.deleted && v.transactions.length > 0);
  const deleted = vouchers.filter((v) => v.deleted);
  const deltas = accountDeltas(active);

  // Structurally invalid source data must fail the year loudly, never render:
  // a #TRANS without an account or a #VER without a date shifts the positional
  // fields and the parser reads the NEXT token as account/date, silently
  // corrupting the voucher.
  for (const voucher of active) {
    const label = `${voucher.seriesShortName || '?'}-${voucher.number}`;
    if (!voucher.bookingDate) {
      throw new Error(`WINT voucher ${label} has no booking date; refusing to render SIE`);
    }
    for (const t of voucher.transactions) {
      if (!t.accountNumber) {
        throw new Error(`WINT voucher ${label} has a transaction without an account number; refusing to render SIE`);
      }
    }
  }

  // Every account referenced anywhere must be declared with #KONTO.
  const accountNames = new Map<string, WintSieAccount>();
  for (const account of accounts) accountNames.set(account.accountNumber, account);
  const referenced = new Set<string>([...deltas.keys(), ...ibByAccount.keys()]);
  for (const account of accounts) referenced.add(account.accountNumber);

  const lines: string[] = [];
  lines.push('#FLAGGA 0');
  lines.push(`#PROGRAM ${quote('Accounted')} ${quote(programVersion)}`);
  // Declared PC8 with a UTF-8 body, the same de-facto convention Fortnox and
  // Bokio ship: this file goes straight into our own parser, whose encoding
  // detection ignores the header, and never leaves the import pipeline as
  // bytes. Revisit if the raw file is ever offered for download.
  lines.push('#FORMAT PC8');
  lines.push(`#GEN ${fmtDate(generatedDate)}`);
  lines.push('#SIETYP 4');
  if (orgNumber) lines.push(`#ORGNR ${orgNumber}`);
  lines.push(`#FNAMN ${quote(companyName)}`);
  lines.push(`#RAR 0 ${fmtDate(year.start)} ${fmtDate(year.end)}`);
  if (previousYear) {
    lines.push(`#RAR -1 ${fmtDate(previousYear.start)} ${fmtDate(previousYear.end)}`);
  }
  lines.push('#KPTYP EUBAS97');
  if (deleted.length > 0) {
    // BFL 5 kap 6-7 §: the voucher number series must be accounted for. WINT
    // flags these vouchers Deleted and excludes them from its own ledger, so
    // they cannot be rendered as transactions, but the resulting gaps in the
    // series must be documented in the file rather than silently inherited.
    const numbers = deleted
      .map((v) => `${v.seriesShortName || 'A'}-${v.number}`)
      .slice(0, 50)
      .join(', ');
    lines.push(`#PROSA ${quote(
      `${deleted.length} verifikat exkluderade (raderade i källsystemet WINT): ${numbers}${deleted.length > 50 ? ', ...' : ''}`,
    )}`);
  }

  // Chart of accounts
  const sortedAccounts = [...referenced].sort((a, b) => a.localeCompare(b, 'sv'));
  for (const accountNumber of sortedAccounts) {
    const meta = accountNames.get(accountNumber);
    lines.push(`#KONTO ${accountNumber} ${quote(meta?.name || `Konto ${accountNumber}`)}`);
    if (meta?.sruCode) lines.push(`#SRU ${accountNumber} ${meta.sruCode}`);
  }

  // Dimensions actually used
  const usedDimensions = new Map<number, Map<string, string>>();
  for (const voucher of active) {
    for (const t of voucher.transactions) {
      for (const ref of sieDimensionRefs(t)) {
        if (!usedDimensions.has(ref.dimNo)) usedDimensions.set(ref.dimNo, new Map());
        usedDimensions.get(ref.dimNo)!.set(ref.objectNo, ref.objectName);
      }
    }
  }
  for (const [dimNo, objects] of [...usedDimensions.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`#DIM ${dimNo} ${quote(SIE_DIMENSION_NAMES[dimNo] ?? `Dimension ${dimNo}`)}`);
    for (const [objectNo, objectName] of [...objects.entries()].sort((a, b) => a[0].localeCompare(b[0], 'sv'))) {
      lines.push(`#OBJEKT ${dimNo} ${quote(objectNo)} ${quote(objectName)}`);
    }
  }

  // Balances: #IB/#UB for balance-sheet accounts, #RES for result accounts.
  for (const accountNumber of sortedAccounts) {
    if (!isBalanceSheetAccount(accountNumber)) continue;
    const ib = round2(ibByAccount.get(accountNumber) ?? 0);
    const ub = round2(ib + (deltas.get(accountNumber) ?? 0));
    if (ib === 0 && ub === 0) continue;
    lines.push(`#IB 0 ${accountNumber} ${fmtAmount(ib)}`);
    lines.push(`#UB 0 ${accountNumber} ${fmtAmount(ub)}`);
  }
  for (const accountNumber of sortedAccounts) {
    if (isBalanceSheetAccount(accountNumber)) continue;
    const res = round2(deltas.get(accountNumber) ?? 0);
    if (res === 0) continue;
    lines.push(`#RES 0 ${accountNumber} ${fmtAmount(res)}`);
  }

  // Vouchers, ascending per series
  const sorted = [...active].sort((a, b) =>
    a.seriesShortName === b.seriesShortName
      ? a.number - b.number
      : a.seriesShortName.localeCompare(b.seriesShortName, 'sv'),
  );
  for (const voucher of sorted) {
    const series = voucher.seriesShortName || 'A';
    const header = `#VER ${quote(series)} ${voucher.number} ${fmtDate(voucher.bookingDate)}`
      + (voucher.text ? ` ${quote(voucher.text)}` : '');
    lines.push(header);
    lines.push('{');
    for (const t of voucher.transactions) {
      const refs = sieDimensionRefs(t);
      const objectList = refs.length > 0
        ? `{${refs.map((r) => `${r.dimNo} ${quote(r.objectNo)}`).join(' ')}}`
        : '{}';
      let line = `   #TRANS ${t.accountNumber} ${objectList} ${fmtAmount(t.amount)}`;
      const transDate = t.bookingDate ? fmtDate(t.bookingDate) : undefined;
      if (transDate && transDate !== fmtDate(voucher.bookingDate)) {
        line += ` ${transDate}`;
        if (t.text) line += ` ${quote(t.text)}`;
      } else if (t.text) {
        // transtext is positional after transdate: emit the date when a text follows
        line += ` ${fmtDate(voucher.bookingDate)} ${quote(t.text)}`;
      }
      lines.push(line);
    }
    lines.push('}');
  }

  return lines.join('\r\n') + '\r\n';
}
