/**
 * VIES (the EU's VAT number register), faked at its own hostname.
 *
 * The fake answers at `ec.europa.eu`, which is where lib/vat/vies-client.ts
 * sends its request in production: the host is hardcoded there, so there is no
 * base URL to point somewhere else and the app needs no test-only config. Same
 * arrangement as the Enable Banking fake.
 *
 * The one endpoint the client calls:
 *   GET /taxation_customs/vies/rest-api/ms/{cc}/vat/{number} → { isValid, name, address }
 *
 * Why it is worth faking rather than skipping: a verified buyer VAT number is
 * one of the conditions for invoicing without Swedish VAT, and the app enforces
 * it (getAvailableVatRates only offers reverse charge to an EU business whose
 * number is validated). Without the fake, the reverse-charge branch of the
 * invoice editor is unreachable and the rule is untested.
 */
import { defineFake } from "@specific.dev/spectest";

export const VIES_HOSTNAME = "ec.europa.eu";

/** Registered numbers, keyed as they arrive on the wire: country then digits. */
const REGISTERED: Record<string, { name: string; address: string }> = {
  "DE811234567": {
    name: "Muster Handels GmbH",
    address: "Musterstrasse 1, 10115 Berlin",
  },
};

export interface ViesState {
  /** Every lookup the app made, in order. */
  calls: Array<{ country: string; number: string }>;
  /** Flip to make the register answer 503, the way a real outage does. */
  outage: boolean;
}

export interface ViesHelpers extends Record<string, unknown> {
  /** Every lookup the app made, in order. */
  calls(): { country: string; number: string }[];
  /** Make the register answer 503, the way a real outage does. */
  setOutage(down: boolean): void;
}

export const viesFake = defineFake<ViesState, ViesHelpers>({
  name: "vies",
  hostnames: [VIES_HOSTNAME],
  state: () => ({ calls: [], outage: false }),

  handler: async (req, state) => {
    const url = new URL(req.url);
    const match = url.pathname.match(
      /^\/taxation_customs\/vies\/rest-api\/ms\/([A-Z]{2})\/vat\/(.+)$/,
    );
    if (!match) {
      return new Response("not found", { status: 404 });
    }

    const [, country, number] = match;
    state.calls.push({ country, number });

    // A register that is down must not read as "valid". The client turns a
    // non-ok response into valid: false with a service message, and this is
    // what lets a test prove it.
    if (state.outage) {
      return new Response("service unavailable", { status: 503 });
    }

    const entry = REGISTERED[`${country}${number}`];
    return Response.json(
      entry
        ? { isValid: true, name: entry.name, address: entry.address }
        : { isValid: false, name: "", address: "" },
    );
  },

  helpers: ({ state }) => ({
    calls() {
      return state.calls.map((c) => ({ ...c }));
    },
    setOutage(down: boolean) {
      state.outage = down;
    },
  }),
});
