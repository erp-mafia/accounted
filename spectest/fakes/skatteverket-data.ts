/**
 * Fixture data for the Skatteverket fake.
 *
 * The skattekonto deposit mirrors the bank fixture's outgoing payment to
 * SKATTEVERKET (43 120 kr, 7 days ago), so the two systems agree about the
 * same event seen from opposite sides. That is what makes a skattekonto
 * reconciliation testable at all: money left the bank on one date and landed
 * at Skatteverket on the same one.
 */

export const SKV_OAUTH_HOSTNAME = "peroauth2.test.skatteverket.se";
export const SKV_API_HOSTNAME = "api.test.skatteverket.se";

/** The company the aktiebolag branch onboards as. */
export const ORG_NUMBER = "5566778899";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export interface BookedFixture {
  id: number;
  daysAgo: number;
  text: string;
  amount: number;
}

/** Booked, in the order Skatteverket returns them: newest first. */
export const BOOKED: BookedFixture[] = [
  { id: 900_003, daysAgo: 5, text: "Moms redovisad", amount: -12000 },
  { id: 900_002, daysAgo: 5, text: "Debiterad preliminärskatt", amount: -28000 },
  { id: 900_001, daysAgo: 7, text: "Inbetalning bokförd", amount: 43120 },
];

/** Scheduled, not yet booked. Negative daysAgo is in the future. */
export const UPCOMING = [
  {
    daysAgo: -12,
    dueDaysAgo: -12,
    text: "Debiterad preliminärskatt",
    amount: -28000,
  },
];

/** 43 120 in, 40 000 out. */
export const SALDO = BOOKED.reduce((sum, t) => sum + t.amount, 0);

export function buildSaldo() {
  return {
    nastaAvstamningsdatum: isoDaysAgo(-9),
    senastUppdaterad: new Date().toISOString(),
    informationstext: [
      "Saldot är preliminärt fram till nästa avstämning.",
    ],
    saldoSkatteverket: SALDO,
    saldoKronofogden: 0,
    rantaSkatteverket: 0,
    rantaKronofogden: 0,
    ocrNummer: "16556677889912",
  };
}

export function buildTransaktioner() {
  return {
    tidigareTransaktioner: BOOKED.map((t) => ({
      transaktionsidentitet: t.id,
      transaktionsdatum: isoDaysAgo(t.daysAgo),
      ranteberakningsdatum: isoDaysAgo(t.daysAgo),
      transaktionstext: t.text,
      beloppSkatteverket: t.amount,
      beloppKronofogden: null,
    })),
    kommandeTransaktioner: UPCOMING.map((t) => ({
      transaktionsdatum: isoDaysAgo(t.daysAgo),
      forfallodatum: isoDaysAgo(t.dueDaysAgo),
      ranteberakningsdatum: null,
      transaktionstext: t.text,
      beloppSkatteverket: t.amount,
      beloppKronofogden: null,
      transaktionsidentitet: null,
    })),
  };
}
