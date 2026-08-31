/**
 * Enable Banking (PSD2), faked at its own hostname.
 *
 * The fake answers at `api.enablebanking.com`, which is the default
 * ENABLE_BANKING_API_URL in extensions/general/enable-banking/lib/api-client.ts.
 * The app therefore needs no test-only configuration at all: it calls the
 * address it calls in production and lands here.
 *
 * The app signs a real RS256 JWT (lib/jwt.ts). This fake checks the token's
 * SHAPE — RS256, a `kid` carrying the Enable Banking app id, the right
 * audience, not expired — but not its signature.
 *
 * That split is deliberate. Verifying the signature needs the public half of
 * the app's keypair, and a keypair generated per run would change the app's
 * environment on every run and force a cold rebuild, while a committed private
 * key does not belong in the repo. The cryptographic check costs nothing in
 * vitest, where a throwaway keypair is free, so it lives there:
 * tests/e2e/__tests__/enable-banking-fake.test.ts.
 *
 * Endpoints mirror what the client actually calls:
 *   GET    /aspsps                        list of banks
 *   POST   /auth                          begin consent, returns an SCA url
 *   POST   /sessions                      exchange the code for a session
 *   GET    /sessions/{id}                 session health
 *   DELETE /sessions/{id}                 disconnect
 *   GET    /accounts/{uid}/balances
 *   GET    /accounts/{uid}/transactions   paginated via continuation_key
 *
 * Plus the SCA page itself, which the browser visits: a BankID step that looks
 * like a bank's, so the replay shows a real-looking consent flow rather than a
 * bare redirect.
 */
import { defineFake } from "@specific.dev/spectest";
import * as crypto from "node:crypto";
import {
  ASPSPS,
  ACCOUNTS,
  BALANCES,
  buildTransactions,
  EB_HOSTNAME,
} from "./enable-banking-data";

export interface EnableBankingState {
  authorizations: Map<
    string,
    {
      redirectUrl: string;
      state: string;
      aspspName: string;
      aspspCountry: string;
      psuType: string;
      authMethod: string | null;
      validUntil?: string;
    }
  >;
  codes: Map<string, string>;
  sessions: Map<string, unknown>;
  /** Lifecycle the bank reports. Flip to CLOSED to kill a consent bank-side. */
  sessionStatus: string;
  /** When set, transaction reads fail with this status. */
  transactionsError: number | null;
  /** Every authenticated request the app made, for assertions. */
  calls: { method: string; path: string; rejected?: string }[];
}

export interface EnableBankingHelpers extends Record<string, unknown> {
  /** Paths the app actually requested, in order. */
  calls(): { method: string; path: string; rejected?: string }[];
  /** The auth method the app pinned for the pending consent, if any. */
  pinnedAuthMethod(): string | null;
  /** Kill the consent bank-side, the way an expired or revoked one dies. */
  closeSession(): void;
  /** Bring it back. */
  reopenSession(): void;
  /** Make transaction reads fail with `status`. */
  failTransactions(status: number): void;
  /** How many consents are live. */
  liveSessions(): number;
}

/**
 * Check the bearer token the app sends looks like the JWT Enable Banking
 * expects. Signature verification is the vitest contract test's job (see the
 * file header); everything checkable without key material is checked here.
 */
function verifyJwt(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return "missing bearer token";
  const token = header.slice(7);

  const parts = token.split(".");
  if (parts.length !== 3) return "malformed jwt";
  const [h, p] = parts;

  let head: { alg?: string; kid?: string };
  try {
    head = JSON.parse(Buffer.from(h, "base64url").toString());
  } catch {
    return "unparseable jwt header";
  }
  if (head.alg !== "RS256") return `unexpected alg ${head.alg}`;
  if (!head.kid) return "jwt header missing kid (the Enable Banking app id)";

  let payload: { exp?: number; aud?: string };
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return "unparseable jwt payload";
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000))
    return "jwt expired";
  if (payload.aud !== "api.enablebanking.com")
    return `unexpected aud ${payload.aud}`;
  return null;
}

function scaPage(authorizationId: string, bank: string): string {
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${bank} - Identifiering</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background:#f4f5f7; color:#14181f; display:flex; align-items:center;
         justify-content:center; min-height:100vh; }
  .card { background:#fff; border-radius:14px; padding:40px; width:min(420px, 92vw);
          box-shadow:0 1px 3px rgba(0,0,0,.08), 0 10px 32px rgba(0,0,0,.06); }
  .bank { font-size:13px; letter-spacing:.08em; text-transform:uppercase;
          color:#6b7280; margin:0 0 6px; }
  h1 { font-size:21px; margin:0 0 8px; }
  p { color:#4b5563; font-size:14px; line-height:1.55; margin:0 0 26px; }
  label { display:block; font-size:13px; font-weight:600; margin:0 0 6px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; font-size:15px;
          border:1px solid #d1d5db; border-radius:8px; margin:0 0 20px; }
  button { width:100%; padding:13px; font-size:15px; font-weight:600; color:#fff;
           background:#0b5cff; border:0; border-radius:8px; cursor:pointer; }
  .note { margin:22px 0 0; font-size:12px; color:#9ca3af; text-align:center; }
</style>
</head>
<body>
  <main class="card">
    <p class="bank">${bank}</p>
    <h1>Identifiera dig med BankID</h1>
    <p>Ange ditt personnummer och godkänn sedan i BankID-appen för att ge Accounted läsbehörighet till dina konton.</p>
    <form method="POST" action="/sca/${authorizationId}/approve">
      <label for="pnr">Personnummer</label>
      <input id="pnr" name="pnr" inputmode="numeric" value="19850101-1234">
      <button type="submit" id="approve">Godkänn i BankID</button>
    </form>
    <p class="note">Testmiljö. Ingen riktig BankID-signering sker.</p>
  </main>
</body>
</html>`;
}

const json = (body: unknown, status = 200) =>
  Response.json(body as Record<string, unknown>, { status });

export const enableBankingFake = defineFake<
  EnableBankingState,
  EnableBankingHelpers
>({
  name: "enable-banking",
  hostnames: [EB_HOSTNAME],
  state: () => ({
    authorizations: new Map(),
    codes: new Map(),
    sessions: new Map(),
    sessionStatus: "VALID",
    transactionsError: null,
    calls: [],
  }),

  handler: async (req, state) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // The SCA pages the browser visits are part of the bank's own web flow,
    // not its API, so they carry no bearer token.
    if (path.startsWith("/sca/") && method === "GET") {
      const id = path.split("/")[2];
      const auth = state.authorizations.get(id);
      if (!auth)
        return new Response("<h1>Okänd auktorisering</h1>", { status: 404 });
      return new Response(scaPage(id, auth.aspspName), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (
      path.startsWith("/sca/") &&
      path.endsWith("/approve") &&
      method === "POST"
    ) {
      const id = path.split("/")[2];
      const auth = state.authorizations.get(id);
      if (!auth)
        return new Response("<h1>Okänd auktorisering</h1>", { status: 404 });

      const code = `code-${crypto.randomUUID()}`;
      state.codes.set(code, id);

      const back = new URL(auth.redirectUrl);
      back.searchParams.set("code", code);
      if (auth.state) back.searchParams.set("state", auth.state);
      return new Response(null, {
        status: 302,
        headers: { location: back.toString() },
      });
    }

    const authError = verifyJwt(req);
    if (authError) {
      state.calls.push({ method, path, rejected: authError });
      return json({ error: "UNAUTHORIZED", message: authError }, 401);
    }
    state.calls.push({ method, path: path + url.search });

    if (path === "/aspsps" && method === "GET") {
      const country = url.searchParams.get("country") ?? "SE";
      const psuType = url.searchParams.get("psu_type") ?? "business";
      const aspsps = ASPSPS.filter((a) => a.country === country).map((a) => ({
        ...a,
        auth_methods: a.auth_methods.filter(
          (m) => !m.psu_types?.length || m.psu_types.includes(psuType),
        ),
      }));
      return json({ aspsps });
    }

    if (path === "/auth" && method === "POST") {
      const body = (await req.json()) as {
        aspsp?: { name?: string; country?: string };
        redirect_url?: string;
        state?: string;
        psu_type?: string;
        auth_method?: string;
        access?: { valid_until?: string };
      };
      if (!body.aspsp?.name || !body.redirect_url) {
        return json(
          {
            error: "INVALID_REQUEST",
            message: "aspsp.name and redirect_url are required",
          },
          400,
        );
      }
      const authorizationId = crypto.randomUUID();
      state.authorizations.set(authorizationId, {
        redirectUrl: body.redirect_url,
        state: body.state ?? "",
        aspspName: body.aspsp.name,
        aspspCountry: body.aspsp.country ?? "SE",
        psuType: body.psu_type ?? "business",
        authMethod: body.auth_method ?? null,
        validUntil: body.access?.valid_until,
      });
      return json({
        url: `https://${EB_HOSTNAME}/sca/${authorizationId}`,
        authorization_id: authorizationId,
      });
    }

    if (path === "/sessions" && method === "POST") {
      const body = (await req.json()) as { code?: string };
      const authorizationId = body.code
        ? state.codes.get(body.code)
        : undefined;
      if (!authorizationId) {
        return json(
          { error: "INVALID_CODE", message: "unknown or already-used code" },
          400,
        );
      }
      // Single use: a replayed code must not mint a second consent.
      state.codes.delete(body.code!);
      const auth = state.authorizations.get(authorizationId)!;

      const sessionId = crypto.randomUUID();
      const session = {
        session_id: sessionId,
        access: {
          valid_until:
            auth.validUntil ??
            new Date(Date.now() + 90 * 86400000).toISOString(),
        },
        accounts: ACCOUNTS,
        aspsp: { name: auth.aspspName, country: auth.aspspCountry },
        psu_type: auth.psuType,
        status: "VALID",
      };
      state.sessions.set(sessionId, session);
      return json(session);
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      const session = state.sessions.get(id) as
        Record<string, unknown> | undefined;
      if (!session) return json({ error: "SESSION_NOT_FOUND" }, 404);
      if (method === "DELETE") {
        state.sessions.delete(id);
        return json({ ok: true });
      }
      return json({ ...session, status: state.sessionStatus });
    }

    const balanceMatch = path.match(/^\/accounts\/([^/]+)\/balances$/);
    if (balanceMatch && method === "GET") {
      const uid = balanceMatch[1];
      const amount = BALANCES[uid];
      if (!amount) return json({ error: "ACCOUNT_NOT_FOUND" }, 404);
      const currency = uid.startsWith("acc-eur") ? "EUR" : "SEK";
      return json({
        balances: [
          {
            balance_amount: { amount, currency },
            balance_type: "CLBD",
            reference_date: new Date().toISOString().slice(0, 10),
            last_change_date_time: new Date().toISOString(),
          },
        ],
      });
    }

    const txMatch = path.match(/^\/accounts\/([^/]+)\/transactions$/);
    if (txMatch && method === "GET") {
      const uid = txMatch[1];
      if (!BALANCES[uid]) return json({ error: "ACCOUNT_NOT_FOUND" }, 404);

      // A dead consent answers 401 with a session-expiry signal, which is
      // what tells the app to show the reconnect banner instead of retrying.
      if (state.sessionStatus !== "VALID") {
        return json(
          { error: "CLOSED_SESSION", message: "Session is closed" },
          401,
        );
      }
      if (state.transactionsError) {
        return json({ error: "UPSTREAM_ERROR" }, state.transactionsError);
      }

      const dateFrom = url.searchParams.get("date_from");
      const dateTo = url.searchParams.get("date_to");
      let all = buildTransactions(uid);
      if (dateFrom) all = all.filter((t) => t.booking_date >= dateFrom);
      if (dateTo) all = all.filter((t) => t.booking_date <= dateTo);

      // Ten at a time regardless of the client's limit, so the pagination
      // loop in getAllTransactions() is exercised rather than short-circuited.
      const PAGE = 10;
      const cont = url.searchParams.get("continuation_key");
      const offset = cont ? Number(cont) : 0;
      const page = all.slice(offset, offset + PAGE);
      const next = offset + PAGE;

      return json(
        next < all.length
          ? { transactions: page, continuation_key: String(next) }
          : { transactions: page },
      );
    }

    return json({ error: "NOT_FOUND", path }, 404);
  },

  helpers: ({ state }) => ({
    calls() {
      return state.calls.map((c) => ({ ...c }));
    },
    pinnedAuthMethod() {
      const last = [...state.authorizations.values()].at(-1);
      return last?.authMethod ?? null;
    },
    closeSession() {
      state.sessionStatus = "CLOSED";
    },
    reopenSession() {
      state.sessionStatus = "VALID";
    },
    failTransactions(status: number) {
      state.transactionsError = status;
    },
    liveSessions() {
      return state.sessions.size;
    },
  }),
});
