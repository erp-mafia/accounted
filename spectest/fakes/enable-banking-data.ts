/**
 * Fixture data for the Enable Banking fake.
 *
 * Kept apart from the handler so the test files can import the same constants
 * they assert against: a test that checks "18 750,00 kr from Nordic Design AB
 * is on the page" reads the amount from here rather than repeating it.
 */

export const EB_HOSTNAME = "api.enablebanking.com";

export const SEK_ACCOUNT_UID = "acc-sek-0000-0000-0000-000000000001";
export const EUR_ACCOUNT_UID = "acc-eur-0000-0000-0000-000000000002";

export interface AuthMethod {
  name: string;
  title?: string;
  approach?: "REDIRECT" | "DECOUPLED" | "EMBEDDED";
  hidden_method?: boolean;
  psu_types?: string[];
}

export const ASPSPS: {
  name: string;
  country: string;
  bic: string;
  max_consent_validity: number;
  auth_methods: AuthMethod[];
}[] = [
  {
    name: "Swedbank",
    country: "SE",
    bic: "SWEDSESS",
    max_consent_validity: 7776000,
    auth_methods: [
      {
        name: "SE_BANKID_REDIRECT",
        title: "Mobilt BankID",
        approach: "REDIRECT",
        psu_types: ["personal", "business"],
      },
    ],
  },
  {
    // The case selectPreferredAuthMethod() exists for: the visible default
    // fails for corporate PSUs upstream, and the working Mobile BankID method
    // is hidden, so it is only reachable when pinned explicitly.
    name: "Handelsbanken",
    country: "SE",
    bic: "HANDSESS",
    max_consent_validity: 7776000,
    auth_methods: [
      { name: "SE_CARD_READER", title: "Dosa", approach: "REDIRECT", psu_types: ["business"] },
      {
        name: "SE_BANKID_DECOUPLED",
        title: "Mobilt BankID",
        approach: "DECOUPLED",
        hidden_method: true,
        psu_types: ["business"],
      },
    ],
  },
  {
    // The mirror case: a VISIBLE decoupled method is already part of the
    // bank's default flow. Pinning it is the PR #854 regression that broke
    // Lunar-class banks, so the app must leave this one alone.
    name: "Lunar",
    country: "SE",
    bic: "LUNASE22",
    max_consent_validity: 7776000,
    auth_methods: [
      {
        name: "SE_BANKID_DECOUPLED",
        title: "Mobilt BankID",
        approach: "DECOUPLED",
        hidden_method: false,
        psu_types: ["personal", "business"],
      },
    ],
  },
  {
    name: "SEB",
    country: "SE",
    bic: "ESSESESS",
    max_consent_validity: 7776000,
    auth_methods: [
      {
        name: "SE_BANKID_REDIRECT",
        title: "Mobilt BankID",
        approach: "REDIRECT",
        psu_types: ["personal", "business"],
      },
    ],
  },
];

export const ACCOUNTS = [
  {
    uid: SEK_ACCOUNT_UID,
    account_id: { iban: "SE4550000000058398257466", bban: "83982574665" },
    name: "Företagskonto",
    product: "Företagskonto",
    currency: "SEK",
    identification_hash: "hash-sek-1",
  },
  {
    uid: EUR_ACCOUNT_UID,
    account_id: { iban: "SE3550000000054910000003", bban: "49100000031" },
    name: "Valutakonto EUR",
    product: "Valutakonto",
    currency: "EUR",
    identification_hash: "hash-eur-2",
  },
];

export const BALANCES: Record<string, string> = {
  [SEK_ACCOUNT_UID]: "184320.55",
  [EUR_ACCOUNT_UID]: "4210.00",
};

interface Fixture {
  daysAgo: number;
  amount: string;
  ind: "CRDT" | "DBIT";
  creditor?: string;
  debtor?: string;
  remittance: string[];
  code: string;
  mcc?: string;
  proprietary?: string;
}

/**
 * Realistic Swedish business-account activity, expressed as days-ago so the
 * fixture stays inside the PSD2 90-day window without rotting.
 *
 * Each entry earns its place by exercising a different path downstream:
 * customer payments carrying an OCR reference (invoice matching), supplier
 * payments naming the supplier (supplier matching), card purchases with an MCC
 * (categorisation), a Skatteverket payment (skattekonto reconciliation), a
 * salary run (payroll), öre-level amounts (rounding), and one transaction with
 * neither remittance text nor a counterparty, which is what the description
 * fallback has to cope with.
 */
export const SEK_TRANSACTIONS: Fixture[] = [
  { daysAgo: 2, amount: "18750.00", ind: "CRDT", debtor: "NORDIC DESIGN AB", remittance: ["Betalning faktura 2026-114", "OCR 1141234567890"], code: "PMNT-RCDT-ESCT" },
  { daysAgo: 3, amount: "2487.50", ind: "DBIT", creditor: "TELIA SVERIGE AB", remittance: ["Autogiro Telia 4471028"], code: "PMNT-ICDT-AUTT" },
  { daysAgo: 5, amount: "1249.00", ind: "DBIT", creditor: "DUSTIN SVERIGE AB", remittance: ["Kortköp DUSTIN.SE"], mcc: "5732", code: "PMNT-CCRD-POSD" },
  { daysAgo: 7, amount: "43120.00", ind: "DBIT", creditor: "SKATTEVERKET", remittance: ["Inbetalning skattekonto 16556677-8899"], code: "PMNT-ICDT-ESCT" },
  { daysAgo: 9, amount: "96500.00", ind: "DBIT", creditor: "LÖNEUTBETALNING", remittance: ["Lön augusti"], code: "PMNT-ICDT-SALA" },
  { daysAgo: 11, amount: "389.90", ind: "DBIT", creditor: "CIRCLE K", remittance: ["Kortköp CIRCLE K STHLM"], mcc: "5541", code: "PMNT-CCRD-POSD" },
  { daysAgo: 12, amount: "62.75", ind: "DBIT", remittance: [], code: "PMNT-RCDT-CHRG", proprietary: "AVGIFT" },
  { daysAgo: 15, amount: "7350.25", ind: "CRDT", debtor: "BRF SOLGÅRDEN", remittance: ["Faktura 2026-108"], code: "PMNT-RCDT-ESCT" },
  { daysAgo: 18, amount: "12000.00", ind: "DBIT", creditor: "HYRESVÄRDEN FASTIGHETS AB", remittance: ["Hyra kontor september"], code: "PMNT-ICDT-ESCT" },
  { daysAgo: 21, amount: "4990.00", ind: "CRDT", debtor: "SWISH", remittance: ["Swish från Anna Lindqvist"], code: "PMNT-RCDT-ESCT" },
  { daysAgo: 25, amount: "899.00", ind: "DBIT", creditor: "AMAZON WEB SERVICES", remittance: ["AWS EMEA"], mcc: "7372", code: "PMNT-CCRD-POSD" },
  { daysAgo: 30, amount: "25400.00", ind: "CRDT", debtor: "KOMMUNAL FÖRVALTNING", remittance: ["Betalning faktura 2026-101", "OCR 1011234567897"], code: "PMNT-RCDT-ESCT" },
  { daysAgo: 34, amount: "3125.00", ind: "DBIT", creditor: "FORTUM MARKETS AB", remittance: ["El kontor juli"], code: "PMNT-ICDT-AUTT" },
  { daysAgo: 41, amount: "156.40", ind: "DBIT", creditor: "SL", remittance: ["Kortköp SL BILJETT"], mcc: "4111", code: "PMNT-CCRD-POSD" },
  { daysAgo: 47, amount: "9800.00", ind: "CRDT", debtor: "VÄSTKUST MEDIA AB", remittance: ["Faktura 2026-096"], code: "PMNT-RCDT-ESCT" },
  { daysAgo: 52, amount: "2199.00", ind: "DBIT", creditor: "APPLE DISTRIBUTION INTERNATIONAL", remittance: ["Kortköp APPLE.COM/BILL"], mcc: "5734", code: "PMNT-CCRD-POSD" },
  { daysAgo: 58, amount: "41000.00", ind: "DBIT", creditor: "SKATTEVERKET", remittance: ["Inbetalning skattekonto 16556677-8899"], code: "PMNT-ICDT-ESCT" },
  { daysAgo: 63, amount: "96500.00", ind: "DBIT", creditor: "LÖNEUTBETALNING", remittance: ["Lön juni"], code: "PMNT-ICDT-SALA" },
  { daysAgo: 71, amount: "14375.80", ind: "CRDT", debtor: "NORDIC DESIGN AB", remittance: ["Betalning faktura 2026-089", "OCR 891234567895"], code: "PMNT-RCDT-ESCT" },
  { daysAgo: 84, amount: "525.00", ind: "DBIT", creditor: "POSTNORD SVERIGE AB", remittance: ["Frakt"], code: "PMNT-ICDT-ESCT" },
];

export const EUR_TRANSACTIONS: Fixture[] = [
  { daysAgo: 6, amount: "1450.00", ind: "CRDT", debtor: "HELSINKI SOFTWARE OY", remittance: ["Invoice 2026-EU-04"], code: "PMNT-RCDT-ESCT" },
  { daysAgo: 22, amount: "320.00", ind: "DBIT", creditor: "HETZNER ONLINE GMBH", remittance: ["Hetzner invoice"], code: "PMNT-ICDT-ESCT" },
];

/** Counts the tests assert against, derived rather than repeated by hand. */
export const SEK_TX_COUNT = SEK_TRANSACTIONS.length;
export const SEK_INCOMING_COUNT = SEK_TRANSACTIONS.filter((t) => t.ind === "CRDT").length;
export const SEK_OUTGOING_COUNT = SEK_TRANSACTIONS.filter((t) => t.ind === "DBIT").length;

export interface EbTransaction {
  entry_reference: string;
  transaction_id: string;
  booking_date: string;
  value_date: string;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  remittance_information: string[];
  bank_transaction_code: string;
  creditor_name?: string;
  creditor?: { name: string };
  debtor_name?: string;
  debtor?: { name: string };
  merchant_category_code?: string;
  proprietary_bank_transaction_code?: string;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export function buildTransactions(accountUid: string): EbTransaction[] {
  const isEur = accountUid === EUR_ACCOUNT_UID;
  const fixtures = isEur ? EUR_TRANSACTIONS : SEK_TRANSACTIONS;
  const currency = isEur ? "EUR" : "SEK";

  return fixtures.map((f, i) => {
    const date = isoDaysAgo(f.daysAgo);
    const tx: EbTransaction = {
      // Stable per account so a re-sync dedupes instead of re-importing.
      entry_reference: `${accountUid.slice(0, 7)}-${date}-${i}`,
      transaction_id: `${accountUid.slice(0, 7)}-tx-${i}`,
      booking_date: date,
      value_date: date,
      transaction_amount: { amount: f.amount, currency },
      credit_debit_indicator: f.ind,
      remittance_information: f.remittance,
      bank_transaction_code: f.code,
    };
    if (f.creditor) {
      tx.creditor_name = f.creditor;
      tx.creditor = { name: f.creditor };
    }
    if (f.debtor) {
      tx.debtor_name = f.debtor;
      tx.debtor = { name: f.debtor };
    }
    if (f.mcc) tx.merchant_category_code = f.mcc;
    if (f.proprietary) tx.proprietary_bank_transaction_code = f.proprietary;
    return tx;
  });
}
