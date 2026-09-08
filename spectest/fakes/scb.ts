/**
 * SCB's Företagsregistret (SokPaVar), faked at its own hostname.
 *
 * lib/parties/scb/client.ts calls https://privateapi.scb.se with a client
 * certificate. The fake answers at that hostname over the in-VM CA, so the
 * app keeps its default base URL; the certificate it presents is a throwaway
 * generated in the app image, which the fake does not inspect.
 *
 * The three calls the app makes, all POST with a JSON body of
 * { Variabler: [{ Variabel, Operator, Varde1, Varde2 }], Kategorier: [] }:
 *   /nv0101/v1/sokpavar/api/Je/HamtaForetag  → rows (by org number, or by name)
 *   /nv0101/v1/sokpavar/api/Je/RaknaForetag  → the count for the same body
 * Rows carry SCB's Swedish column names ("Företagsnamn", "Juridisk form, kod",
 * "Momsstatus, kod" ...), the shape lib/parties/scb/map.ts reads.
 */
import { defineFake } from "@specific.dev/spectest";

export const SCB_HOSTNAME = "privateapi.scb.se";
const BASE = "/nv0101/v1/sokpavar/api/Je";

interface Company {
  orgNr: string;
  name: string;
  /** Street line of the postal address, as SCB's PostAdress. */
  adress?: string;
  telefon?: string;
  epost?: string;
  postNr: string;
  ort: string;
  kommun: string;
  lan: string;
  branschKod: string;
  bransch: string;
  /** SCB status code: 1 = verksam. */
  status?: string;
}

/** Org numbers are Luhn-valid legal persons; the names are what the picker shows. */
const COMPANIES: Company[] = [
  { orgNr: "5562529155", name: "Visma Spcs AB", adress: "SAMBANDSVÄGEN 5", telefon: "047056000", epost: "info@vismaspcs.se", postNr: "351 94", ort: "VÄXJÖ", kommun: "Växjö", lan: "Kronoberg", branschKod: "58290", bransch: "Utgivning av annan programvara" },
  { orgNr: "5567947535", name: "Visma Software AB", postNr: "111 23", ort: "STOCKHOLM", kommun: "Stockholm", lan: "Stockholm", branschKod: "62010", bransch: "Dataprogrammering" },
  { orgNr: "5594871682", name: "The Intelligence Company AB (publ)", postNr: "824 30", ort: "HUDIKSVALL", kommun: "Hudiksvall", lan: "Gävleborg", branschKod: "82910", bransch: "Inkassoföretags och kreditupplysningsföretags verksamhet" },
  { orgNr: "5560125790", name: "AKTIEBOLAGET VOLVO", postNr: "405 08", ort: "GÖTEBORG", kommun: "Göteborg", lan: "Västra Götaland", branschKod: "70100", bransch: "Verksamheter som utövas av huvudkontor" },
];

function row(c: Company): Record<string, string> {
  return {
    PeOrgNr: `16${c.orgNr}`,
    OrgNr: c.orgNr,
    Företagsnamn: c.name,
    COAdress: "",
    PostAdress: c.adress ?? "",
    PostNr: c.postNr,
    PostOrt: c.ort,
    "Säteskommun, kod": "0000",
    Säteskommun: c.kommun,
    "Säteslän, kod": "00",
    Säteslän: c.lan,
    "Antal arbetsställen": "1",
    "Stkl, kod": "4",
    Storleksklass: "10-19 anställda",
    "Företagsstatus, kod": c.status ?? "1",
    Företagsstatus: c.status === "2" ? "Ej verksam" : "Är verksam",
    "Registrerad hos SKV, kod": "1",
    "Registrerad hos SKV": "Registrerad",
    "Juridisk form, kod": "49",
    "Juridisk form": "Övriga aktiebolag",
    Startdatum: "2001-01-01",
    Slutdatum: "",
    Registreringsdatum: "2001-01-01",
    "Bransch_1, kod": c.branschKod,
    Bransch_1: c.bransch,
    "Omsättning, år": "2025",
    "Stkl, oms, kod": "6",
    "Storleksklass, oms": "20 000 - 49 999 tkr",
    Telefon: c.telefon ?? "",
    "E-post": c.epost ?? "",
    "Arbetsgivarstatus, kod": "1",
    Arbetsgivarstatus: "Är registrerad som vanlig arbetsgivare",
    "Momsstatus, kod": "1",
    Momsstatus: "Är registrerad för moms",
    "Fskattstatus, kod": "1",
    Fskattstatus: "Är registrerad för F-skatt",
    "Bolagsstatus, kod": "0",
    Bolagsstatus: "Normalläge",
  };
}

interface Query {
  endpoint: "HamtaForetag" | "RaknaForetag";
  variable: string;
  operator: string;
  value: string;
}

export interface ScbState {
  calls: Query[];
  outage: boolean;
}

export interface ScbHelpers extends Record<string, unknown> {
  /** Every query the app made, in order. */
  calls(): Query[];
  /** Make the register answer 503, the way a real outage does. */
  setOutage(down: boolean): void;
}

function matches(q: Query): Company[] {
  const value = q.value.trim().toLowerCase();
  if (q.variable.startsWith("OrgNr")) {
    const digits = value.replace(/\D/g, "");
    return COMPANIES.filter((c) => c.orgNr === digits);
  }
  if (q.variable === "Namn") {
    return COMPANIES.filter((c) =>
      q.operator === "BorjarPa" ? c.name.toLowerCase().startsWith(value) : c.name.toLowerCase().includes(value),
    );
  }
  return [];
}

export const scbFake = defineFake<ScbState, ScbHelpers>({
  name: "scb",
  hostnames: [SCB_HOSTNAME],
  state: () => ({ calls: [], outage: false }),

  handler: async (req, state) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(BASE)) return new Response("not found", { status: 404 });
    if (state.outage) return new Response("Service Unavailable", { status: 503 });
    const endpoint = url.pathname.slice(BASE.length + 1);
    if (req.method === "GET" && (endpoint === "Variabler" || endpoint === "KategorierMedKodtabeller")) {
      return Response.json([]);
    }
    if (req.method !== "POST" || (endpoint !== "HamtaForetag" && endpoint !== "RaknaForetag")) {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json()) as { Variabler?: Array<{ Variabel?: string; Operator?: string; Varde1?: string }> };
    const v = body.Variabler?.[0] ?? {};
    const query: Query = { endpoint, variable: v.Variabel ?? "", operator: v.Operator ?? "", value: v.Varde1 ?? "" };
    state.calls.push(query);
    const hits = matches(query);
    if (endpoint === "RaknaForetag") return Response.json(hits.length);
    return Response.json(hits.map(row));
  },

  helpers: ({ state }) => ({
    calls() {
      return state.calls.map((c) => ({ ...c }));
    },
    setOutage(down) {
      state.outage = down;
    },
  }),
});
