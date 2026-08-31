/**
 * Skatteverket, faked at its own hostnames.
 *
 * The extension's clients default to the test environment when no base URL is
 * configured, so the fake answers at exactly those two hosts and the app needs
 * no test-only configuration:
 *
 *   peroauth2.test.skatteverket.se   OAuth (the personal BankID flow)
 *   api.test.skatteverket.se         momsdeklaration, AGI, skattekonto
 *
 * Same arrangement as the Enable Banking and VIES fakes. What it unblocks is
 * everything behind the connection: the skattekonto page could previously only
 * be tested for failing gracefully, and no filing path could be walked at all.
 *
 * The gateway headers are checked rather than ignored. Skatteverket's API
 * gateway rejects a request without Client_Id and Client_Secret before the
 * token is ever looked at, and that is a real failure mode (a deployment with
 * OAuth configured and the gateway subscription missing), so the fake refuses
 * the same way instead of being more forgiving than production.
 */
import { defineFake } from "@specific.dev/spectest";
import {
  SKV_OAUTH_HOSTNAME,
  SKV_API_HOSTNAME,
  buildSaldo,
  buildTransaktioner,
} from "./skatteverket-data";

export interface SkvState {
  /** Every API path the app requested, in order. */
  calls: Array<{ method: string; path: string; org?: string }>;
  /** Codes handed out by the authorize page, with where to send them back. */
  codes: Map<string, { state: string; redirectUri: string }>;
  /** Access tokens the token endpoint has issued. */
  tokens: Set<string>;
  /** How many times a refresh has been asked for. */
  refreshes: number;
  /** Force the felkod envelope on skattekonto reads (1-5). */
  felkod: number | null;
  /** Make the gateway reject with 401, the way a dead consent does. */
  unauthorized: boolean;
}

export interface SkvHelpers extends Record<string, unknown> {
  /** API paths the app actually requested, in order. */
  calls(): { method: string; path: string; org?: string }[];
  /** Force Skatteverket's felkod envelope: 3 = no skattekonto, 5 = closed. */
  setFelkod(code: number | null): void;
  /** Make every API call 401, the way an expired consent does. */
  expireConsent(): void;
  /** Undo it. */
  restoreConsent(): void;
  /** How many refresh_token grants were exchanged. */
  refreshes(): number;
}

/**
 * The BankID page the browser actually visits, so the replay looks real.
 *
 * A real form posting to a real endpoint, not an inline onclick: the same
 * shape the Enable Banking fake uses, and it survives a strict CSP.
 */
function authorizePage(approveAction: string): Response {
  return new Response(
    `<!doctype html><html lang="sv"><head><meta charset="utf-8">
     <title>Skatteverket: logga in</title>
     <style>
       body{font-family:system-ui,sans-serif;margin:0;background:#f4f4f4}
       .box{max-width:26rem;margin:5rem auto;background:#fff;padding:2rem;border-radius:8px}
       h1{font-size:1.25rem;margin:0 0 .5rem}
       p{color:#555;font-size:.95rem}
       button{margin-top:1.5rem;width:100%;padding:.85rem;font-size:1rem;
              background:#005b96;color:#fff;border:0;border-radius:4px;cursor:pointer}
     </style></head><body>
     <div class="box">
       <h1>Legitimera dig med BankID</h1>
       <p>Skatteverket vill veta vem du är innan Accounted får läsa ditt skattekonto.</p>
       <form method="POST" action="${approveAction}">
         <label for="pnr">Personnummer</label>
         <input id="pnr" name="pnr" inputmode="numeric" value="19850101-1234">
         <button type="submit">Öppna BankID</button>
       </form>
       <p style="color:#888;font-size:.85rem">Testmiljö. Ingen riktig BankID-signering sker.</p>
     </div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function felkod(code: number): Response {
  const messages: Record<number, string> = {
    1: "Felaktigt organisationsnummer",
    2: "Felaktigt datum",
    3: "Inget skattekonto registrerat",
    4: "Internt fel",
    5: "Skattekontot är stängt",
  };
  return Response.json(
    { felkod: code, felmeddelande: messages[code] ?? "Fel" },
    { status: code === 4 ? 500 : 400 },
  );
}

export const skatteverketFake = defineFake<SkvState, SkvHelpers>({
  name: "skatteverket",
  hostnames: [SKV_OAUTH_HOSTNAME, SKV_API_HOSTNAME],
  state: () => ({
    calls: [],
    codes: new Map(),
    tokens: new Set(),
    refreshes: 0,
    felkod: null,
    unauthorized: false,
  }),

  handler: async (req, state) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Recorded before any branch, so a test can prove the OAuth round trip
    // happened and not merely that a balance appeared on a screen.
    state.calls.push({ method: req.method, path });

    // ── OAuth ────────────────────────────────────────────────────────
    if (url.hostname === SKV_OAUTH_HOSTNAME) {
      if (path.endsWith("/authorize")) {
        const redirectUri = url.searchParams.get("redirect_uri");
        const returnedState = url.searchParams.get("state") ?? "";
        if (!redirectUri) return new Response("missing redirect_uri", { status: 400 });

        // PKCE is always sent by this client, so its absence is a regression
        // worth failing on rather than tolerating.
        if (!url.searchParams.get("code_challenge")) {
          return new Response("missing code_challenge", { status: 400 });
        }

        const code = `skv-code-${state.codes.size + 1}`;
        state.codes.set(code, { state: returnedState, redirectUri });
        return authorizePage(`/oauth2/v1/per/approve/${code}`);
      }

      const approve = path.match(/^\/oauth2\/v1\/per\/approve\/(.+)$/);
      if (approve && req.method === "POST") {
        const pending = state.codes.get(approve[1]);
        if (!pending) return new Response("unknown code", { status: 400 });
        const back = new URL(pending.redirectUri);
        back.searchParams.set("code", approve[1]);
        back.searchParams.set("state", pending.state);
        return new Response(null, {
          status: 302,
          headers: { Location: back.toString() },
        });
      }

      if (path.endsWith("/token") && req.method === "POST") {
        const body = new URLSearchParams(await req.text());
        const grant = body.get("grant_type");

        // The client credentials are compulsory on both grants.
        if (!body.get("client_id") || !body.get("client_secret")) {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }

        if (grant === "authorization_code") {
          const code = body.get("code") ?? "";
          if (!state.codes.has(code)) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          // Single use, the way a real code is.
          state.codes.delete(code);
          const token = `skv-access-${state.tokens.size + 1}`;
          state.tokens.add(token);
          return Response.json({
            access_token: token,
            refresh_token: `skv-refresh-${state.tokens.size}`,
            expires_in: 3600,
            token_type: "Bearer",
            scope: "skattekonto momsdeklaration",
          });
        }

        if (grant === "refresh_token") {
          state.refreshes += 1;
          const token = `skv-access-r${state.refreshes}`;
          state.tokens.add(token);
          // A real refresh returns a NEW refresh token every time.
          return Response.json({
            access_token: token,
            refresh_token: `skv-refresh-r${state.refreshes}`,
            expires_in: 3600,
            token_type: "Bearer",
            scope: "skattekonto momsdeklaration",
          });
        }

        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      return new Response("not found", { status: 404 });
    }

    // ── API gateway ──────────────────────────────────────────────────
    // Order matters: the gateway checks its own credentials before the
    // bearer token, and answers 401 with no body when they are missing.
    if (!req.headers.get("Client_Id") || !req.headers.get("Client_Secret")) {
      return new Response("", { status: 401 });
    }
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (state.unauthorized) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }

    const skattekonto = path.match(
      /^\/beskattning\/skattekonto\/v2\/skattekonton\/([^/]+)\/(saldo|transaktioner)$/,
    );
    if (skattekonto) {
      const [, org, kind] = skattekonto;
      state.calls[state.calls.length - 1]!.org = org;
      if (state.felkod !== null) return felkod(state.felkod);
      return Response.json(kind === "saldo" ? buildSaldo() : buildTransaktioner());
    }

    return new Response("not found", { status: 404 });
  },

  helpers: ({ state }) => ({
    calls() {
      return state.calls.map((c) => ({ ...c }));
    },
    setFelkod(code: number | null) {
      state.felkod = code;
    },
    expireConsent() {
      state.unauthorized = true;
    },
    restoreConsent() {
      state.unauthorized = false;
    },
    refreshes() {
      return state.refreshes;
    },
  }),
});
