import { roundOre } from '@/lib/money';

/**
 * Numeric field readers for provider payloads.
 *
 * Every provider mapper used to collapse "this field is not in the payload"
 * into a number with `?? 0` or `?? total`. For VAT that is not a harmless
 * default: it is an assertion. A missing `TotalVAT` became "0 kr moms", a
 * missing `Net` became "net equals gross", and the migration then wrote an
 * invoice claiming 25 % moms alongside 0 kr of it. The record balanced, so
 * nothing downstream complained.
 *
 * These helpers return `undefined` for an absent field so callers can tell
 * "the provider says zero" from "the provider did not say". Deciding what to
 * do with genuinely unknown VAT belongs to the caller, not to a `??`.
 */

/**
 * First present, finite numeric value among `keys`.
 *
 * Providers spell the same quantity differently across endpoints and API
 * versions (Fortnox `Net` vs `NetAmount`, Visma `TotalAmount` vs
 * `TotalAmountInvoiceCurrency`), and the live payloads have repeatedly
 * differed from the published spec. Taking a candidate list rather than a
 * single key means an unexpected spelling degrades to `undefined`, which is
 * flagged, instead of to a fabricated zero, which is not.
 *
 * Strings are accepted because several providers serialise decimals as
 * strings; empty strings and nulls are not numbers and are skipped.
 */
export function readNumber(
  raw: Record<string, unknown> | undefined | null,
  keys: readonly string[],
): number | undefined {
  if (!raw) return undefined;

  for (const key of keys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null || value === undefined || value === '') continue;

    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }

  return undefined;
}

/**
 * The VAT figures a provider payload yielded, with "unknown" preserved.
 *
 * `net` and `vat` are independently optional: Fortnox's detail payload gives
 * both, Björn Lundén's list payload gives neither, and a provider that gives
 * only one still lets the third be derived against `gross`.
 */
export interface ResolvedVat {
  /** Amount excluding VAT, or undefined when no evidence established it. */
  net?: number;
  /** VAT amount, or undefined when no evidence established it. */
  vat?: number;
}

/**
 * Complete a net/VAT/gross triple from whichever two are known.
 *
 * Returns only what the inputs support. With just a gross total, both fields
 * come back undefined rather than net = gross and VAT = 0: "we only know what
 * the customer paid" is the honest reading, and the caller flags it.
 *
 * The returned pair ALWAYS satisfies `net + vat === gross`. Providers state
 * all three independently and they need not agree: Fortnox's `Total` is the
 * amount to pay after öresavrundning, while `Net + TotalVAT` is the unrounded
 * `Gross`, so the two differ by up to 50 öre. Passing both through as stated
 * would put that gap into the invoice row, where `subtotal + vat_amount` no
 * longer equals `total`; the header booking path derives the 1510 debit from
 * the sum of its credits, so the receivable would land a few öre away from
 * what the customer actually owes while the verifikat still balanced. The VAT
 * is the figure that must survive intact (it reaches the momsdeklaration), so
 * the gap is absorbed into the net.
 */
export function resolveVatTriple(params: {
  gross: number;
  net?: number;
  vat?: number;
}): ResolvedVat {
  const { gross, net, vat } = params;

  if (vat !== undefined) return { net: roundOre(gross - vat), vat };
  if (net !== undefined) return { net, vat: roundOre(gross - net) };

  return {};
}

/**
 * Product of two optional numbers, undefined unless both are present.
 *
 * Used to reconstruct a line amount from unit price x quantity when the
 * provider's own line-total field is absent. Returning undefined for a
 * missing factor keeps a half-known line from being recorded as 0.
 */
export function multiplyIfBothPresent(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return roundOre(a * b);
}

/**
 * Sum per-line VAT when every line carries an amount, else undefined.
 *
 * A partial sum would understate the total, so one line missing its VAT
 * discards the whole sum rather than reporting a number that is too low.
 */
export function sumLineVat(
  lines: readonly { taxAmount?: { value: number } }[],
): number | undefined {
  if (lines.length === 0) return undefined;
  if (lines.some((line) => line.taxAmount === undefined)) return undefined;

  return roundOre(lines.reduce((sum, line) => sum + (line.taxAmount?.value ?? 0), 0));
}

/**
 * VAT for one line from its rate and net amount.
 *
 * Only when the provider actually stated a rate: `taxPercent` undefined means
 * the rate is unknown, and 0 % is a real answer that must not be invented.
 * Accepts both unit conventions (25 and 0.25) because providers mix them.
 */
export function lineVatFromPercent(
  lineNet: number,
  taxPercent: number | undefined,
): number | undefined {
  if (taxPercent === undefined || !Number.isFinite(taxPercent)) return undefined;

  const rate = taxPercent > 1 ? taxPercent / 100 : taxPercent;
  return roundOre(lineNet * rate);
}
