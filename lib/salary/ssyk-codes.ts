/**
 * SSYK 2012 — Standard för svensk yrkesklassificering, 4-siffernivå (426 koder).
 *
 * Source: SCB:s yrkesregister (SSYK 2012), sheet "4-siffer". Used by the SLP
 * lönestrukturstatistik file, which requires a 4-digit yrkeskod per employee.
 * Generated data — do not hand-edit; regenerate from the SCB workbook.
 */

export interface SsykCode {
  /** 4-digit SSYK 2012 code. */
  code: string
  /** Swedish occupation title (benämning). */
  label: string
}

export const SSYK_CODES: SsykCode[] = [
  {
    "code": "1111",
    "label": "Politiker"
  },
  {
    "code": "1112",
    "label": "General-, landstings- och kommundirektörer m.fl."
  },
  {
    "code": "1113",
    "label": "Chefstjänstemän i intresseorganisationer"
  },
  {
    "code": "1120",
    "label": "Verkställande direktörer m.fl."
  },
  {
    "code": "1211",
    "label": "Ekonomi- och finanschefer, nivå 1"
  },
  {
    "code": "1212",
    "label": "Ekonomi- och finanschefer, nivå 2"
  },
  {
    "code": "1221",
    "label": "Personal- och HR-chefer, nivå 1"
  },
  {
    "code": "1222",
    "label": "Personal- och HR-chefer, nivå 2"
  },
  {
    "code": "1230",
    "label": "Förvaltnings- och planeringschefer"
  },
  {
    "code": "1241",
    "label": "Informations-, kommunikations- och PR-chefer, nivå 1"
  },
  {
    "code": "1242",
    "label": "Informations-, kommunikations - och PR-chefer, nivå 2"
  },
  {
    "code": "1251",
    "label": "Försäljnings- och marknadschefer, nivå 1"
  },
  {
    "code": "1252",
    "label": "Försäljnings- och marknadschefer, nivå 2"
  },
  {
    "code": "1291",
    "label": "Övriga administrations- och servicechefer, nivå 1"
  },
  {
    "code": "1292",
    "label": "Övriga administrations- och servicechefer, nivå 2"
  },
  {
    "code": "1311",
    "label": "IT-chefer, nivå 1"
  },
  {
    "code": "1312",
    "label": "IT-chefer, nivå 2"
  },
  {
    "code": "1321",
    "label": "Inköps-, logistik- och transportchefer, nivå 1"
  },
  {
    "code": "1322",
    "label": "Inköps-, logistik- och transportchefer, nivå 2"
  },
  {
    "code": "1331",
    "label": "Forsknings- och utvecklingschefer, nivå 1"
  },
  {
    "code": "1332",
    "label": "Forsknings- och utvecklingschefer, nivå 2"
  },
  {
    "code": "1341",
    "label": "Chefer inom arkitekt- och ingenjörsverksamhet, nivå 1"
  },
  {
    "code": "1342",
    "label": "Chefer inom arkitekt- och ingenjörsverksamhet, nivå 2"
  },
  {
    "code": "1351",
    "label": "Fastighets- och förvaltningschefer, nivå 1"
  },
  {
    "code": "1352",
    "label": "Fastighets- och förvaltningschefer, nivå 2"
  },
  {
    "code": "1361",
    "label": "Driftchefer inom bygg, anläggning och gruva, nivå 1"
  },
  {
    "code": "1362",
    "label": "Driftchefer inom bygg, anläggning och gruva, nivå 2"
  },
  {
    "code": "1371",
    "label": "Produktionschefer inom tillverkning, nivå 1"
  },
  {
    "code": "1372",
    "label": "Produktionschefer inom tillverkning, nivå 2"
  },
  {
    "code": "1380",
    "label": "Förvaltare inom skogsbruk och lantbruk m.fl."
  },
  {
    "code": "1411",
    "label": "Avdelningschefer inom grund- och gymnasieskola samt vuxenutbildning, nivå 1"
  },
  {
    "code": "1412",
    "label": "Rektorer, nivå 2"
  },
  {
    "code": "1421",
    "label": "Avdelningschefer inom förskola, nivå 1"
  },
  {
    "code": "1422",
    "label": "Förskolechefer, nivå 2"
  },
  {
    "code": "1491",
    "label": "Övriga avdelningschefer inom utbildning, nivå 1"
  },
  {
    "code": "1492",
    "label": "Övriga verksamhetschefer inom utbildning, nivå 2"
  },
  {
    "code": "1511",
    "label": "Klinik- och verksamhetschefer inom hälsa och sjukvård, nivå 1"
  },
  {
    "code": "1512",
    "label": "Avdelnings- och enhetschefer inom hälsa och sjukvård, nivå 2"
  },
  {
    "code": "1521",
    "label": "Avdelningschefer inom socialt och kurativt arbete, nivå 1"
  },
  {
    "code": "1522",
    "label": "Enhetschefer inom socialt och kurativt arbete, nivå 2"
  },
  {
    "code": "1531",
    "label": "Avdelningschefer inom äldreomsorg, nivå 1"
  },
  {
    "code": "1532",
    "label": "Enhetschefer inom äldreomsorg, nivå 2"
  },
  {
    "code": "1540",
    "label": "Chefer och ledare inom trossamfund"
  },
  {
    "code": "1591",
    "label": "Övriga chefer inom samhällsservice, nivå 1"
  },
  {
    "code": "1592",
    "label": "Övriga verksamhetschefer inom samhällsservice, nivå 2"
  },
  {
    "code": "1611",
    "label": "Chefer inom bank, finans och försäkring, nivå 1"
  },
  {
    "code": "1612",
    "label": "Chefer inom bank, finans och försäkring, nivå 2"
  },
  {
    "code": "1711",
    "label": "Hotell- och konferenschefer, nivå 1"
  },
  {
    "code": "1712",
    "label": "Hotell- och konferenschefer, nivå 2"
  },
  {
    "code": "1721",
    "label": "Restaurang- och kökschefer, nivå 1"
  },
  {
    "code": "1722",
    "label": "Restaurang- och kökschefer, nivå 2"
  },
  {
    "code": "1731",
    "label": "Chefer inom handel, nivå 1"
  },
  {
    "code": "1732",
    "label": "Chefer inom handel, nivå 2"
  },
  {
    "code": "1741",
    "label": "Chefer inom friskvård, sport och fritid, nivå 1"
  },
  {
    "code": "1742",
    "label": "Chefer inom friskvård, sport och fritid, nivå 2"
  },
  {
    "code": "1791",
    "label": "Chefer inom övrig servicenäring, nivå 1"
  },
  {
    "code": "1792",
    "label": "Chefer inom övrig servicenäring, nivå 2"
  },
  {
    "code": "2111",
    "label": "Fysiker och astronomer"
  },
  {
    "code": "2112",
    "label": "Meteorologer"
  },
  {
    "code": "2113",
    "label": "Kemister"
  },
  {
    "code": "2114",
    "label": "Geologer och geofysiker m.fl."
  },
  {
    "code": "2121",
    "label": "Matematiker och aktuarier"
  },
  {
    "code": "2122",
    "label": "Statistiker"
  },
  {
    "code": "2131",
    "label": "Cell- och molekylärbiologer m.fl."
  },
  {
    "code": "2132",
    "label": "Växt- och djurbiologer"
  },
  {
    "code": "2133",
    "label": "Farmakologer och biomedicinare"
  },
  {
    "code": "2134",
    "label": "Specialister och rådgivare inom lantbruk m.m."
  },
  {
    "code": "2135",
    "label": "Specialister och rådgivare inom skogsbruk"
  },
  {
    "code": "2141",
    "label": "Civilingenjörsyrken inom logistik och produktionsplanering"
  },
  {
    "code": "2142",
    "label": "Civilingenjörsyrken inom bygg och anläggning"
  },
  {
    "code": "2143",
    "label": "Civilingenjörsyrken inom elektroteknik"
  },
  {
    "code": "2144",
    "label": "Civilingenjörsyrken inom maskinteknik"
  },
  {
    "code": "2145",
    "label": "Civilingenjörsyrken inom kemi och kemiteknik"
  },
  {
    "code": "2146",
    "label": "Civilingenjörsyrken inom gruvteknik och metallurgi"
  },
  {
    "code": "2149",
    "label": "Övriga civilingenjörsyrken"
  },
  {
    "code": "2161",
    "label": "Arkitekter m.fl."
  },
  {
    "code": "2162",
    "label": "Landskapsarkitekter"
  },
  {
    "code": "2163",
    "label": "Planeringsarkitekter m.fl."
  },
  {
    "code": "2164",
    "label": "Lantmätare"
  },
  {
    "code": "2171",
    "label": "Industridesigner"
  },
  {
    "code": "2172",
    "label": "Grafisk formgivare m.fl."
  },
  {
    "code": "2173",
    "label": "Designer inom spel och digitala medier"
  },
  {
    "code": "2179",
    "label": "Övriga designer och formgivare"
  },
  {
    "code": "2181",
    "label": "Arbetsmiljöingenjörer, yrkes- och miljöhygieniker"
  },
  {
    "code": "2182",
    "label": "Miljö- och hälsoskyddsinspektörer"
  },
  {
    "code": "2183",
    "label": "Specialister inom miljöskydd och miljöteknik"
  },
  {
    "code": "2211",
    "label": "Specialistläkare"
  },
  {
    "code": "2212",
    "label": "ST-läkare"
  },
  {
    "code": "2213",
    "label": "AT-läkare"
  },
  {
    "code": "2219",
    "label": "Övriga läkare"
  },
  {
    "code": "2221",
    "label": "Grundutbildade sjuksköterskor"
  },
  {
    "code": "2222",
    "label": "Barnmorskor"
  },
  {
    "code": "2223",
    "label": "Anestesisjuksköterskor"
  },
  {
    "code": "2224",
    "label": "Distriktssköterskor"
  },
  {
    "code": "2225",
    "label": "Psykiatrisjuksköterskor"
  },
  {
    "code": "2226",
    "label": "Ambulanssjuksköterskor m.fl."
  },
  {
    "code": "2227",
    "label": "Geriatriksjuksköterskor"
  },
  {
    "code": "2228",
    "label": "Intensivvårdssjuksköterskor"
  },
  {
    "code": "2231",
    "label": "Operationssjuksköterskor"
  },
  {
    "code": "2232",
    "label": "Barnsjuksköterskor"
  },
  {
    "code": "2233",
    "label": "Skolsköterskor"
  },
  {
    "code": "2234",
    "label": "Företagssköterskor"
  },
  {
    "code": "2235",
    "label": "Röntgensjuksköterskor"
  },
  {
    "code": "2239",
    "label": "Övriga specialistsjuksköterskor"
  },
  {
    "code": "2241",
    "label": "Psykologer"
  },
  {
    "code": "2242",
    "label": "Psykoterapeuter"
  },
  {
    "code": "2250",
    "label": "Veterinärer"
  },
  {
    "code": "2260",
    "label": "Tandläkare"
  },
  {
    "code": "2271",
    "label": "Kiropraktorer och naprapater m.fl."
  },
  {
    "code": "2272",
    "label": "Sjukgymnaster"
  },
  {
    "code": "2273",
    "label": "Arbetsterapeuter"
  },
  {
    "code": "2281",
    "label": "Apotekare"
  },
  {
    "code": "2282",
    "label": "Dietister"
  },
  {
    "code": "2283",
    "label": "Audionomer och logopeder"
  },
  {
    "code": "2284",
    "label": "Optiker"
  },
  {
    "code": "2289",
    "label": "Övriga specialister inom hälso- och sjukvård"
  },
  {
    "code": "2311",
    "label": "Professorer"
  },
  {
    "code": "2312",
    "label": "Universitets- och högskolelektorer"
  },
  {
    "code": "2313",
    "label": "Forskarassistenter m.fl."
  },
  {
    "code": "2314",
    "label": "Doktorander"
  },
  {
    "code": "2319",
    "label": "Övriga universitets- och högskollärare"
  },
  {
    "code": "2320",
    "label": "Lärare i yrkesämnen"
  },
  {
    "code": "2330",
    "label": "Gymnasielärare"
  },
  {
    "code": "2341",
    "label": "Grundskollärare"
  },
  {
    "code": "2342",
    "label": "Fritidspedagoger"
  },
  {
    "code": "2343",
    "label": "Förskollärare"
  },
  {
    "code": "2351",
    "label": "Speciallärare och specialpedagoger m.fl."
  },
  {
    "code": "2352",
    "label": "Studie- och yrkesvägledare"
  },
  {
    "code": "2359",
    "label": "Övriga pedagoger med teoretisk specialistkompetens"
  },
  {
    "code": "2411",
    "label": "Revisorer m.fl."
  },
  {
    "code": "2412",
    "label": "Controller"
  },
  {
    "code": "2413",
    "label": "Finansanalytiker och investeringsrådgivare m.fl."
  },
  {
    "code": "2414",
    "label": "Traders och fondförvaltare"
  },
  {
    "code": "2415",
    "label": "Nationalekonomer och makroanalytiker m.fl."
  },
  {
    "code": "2419",
    "label": "Övriga ekonomer"
  },
  {
    "code": "2421",
    "label": "Lednings- och organisationsutvecklare"
  },
  {
    "code": "2422",
    "label": "Planerare och utredare m.fl."
  },
  {
    "code": "2423",
    "label": "Personal- och HR-specialister"
  },
  {
    "code": "2431",
    "label": "Marknadsanalytiker och marknadsförare m.fl."
  },
  {
    "code": "2432",
    "label": "Informatörer, kommunikatörer och PR-specialister"
  },
  {
    "code": "2511",
    "label": "Systemanalytiker och IT-arkitekter m.fl."
  },
  {
    "code": "2512",
    "label": "Mjukvaru- och systemutvecklare m.fl."
  },
  {
    "code": "2513",
    "label": "Utvecklare inom spel och digitala media"
  },
  {
    "code": "2514",
    "label": "Systemtestare och testledare"
  },
  {
    "code": "2515",
    "label": "Systemförvaltare m.fl."
  },
  {
    "code": "2516",
    "label": "IT-säkerhetsspecialister"
  },
  {
    "code": "2519",
    "label": "Övriga IT-specialister"
  },
  {
    "code": "2611",
    "label": "Advokater"
  },
  {
    "code": "2612",
    "label": "Domare"
  },
  {
    "code": "2613",
    "label": "Åklagare"
  },
  {
    "code": "2614",
    "label": "Affärs- och företagsjurister"
  },
  {
    "code": "2615",
    "label": "Förvaltnings- och organisationsjurister"
  },
  {
    "code": "2619",
    "label": "Övriga jurister"
  },
  {
    "code": "2621",
    "label": "Museiintendenter m.fl."
  },
  {
    "code": "2622",
    "label": "Bibliotekarier och arkivarier"
  },
  {
    "code": "2623",
    "label": "Arkeologer och specialister inom humaniora m.m."
  },
  {
    "code": "2641",
    "label": "Författare m.fl."
  },
  {
    "code": "2642",
    "label": "Journalister m.fl."
  },
  {
    "code": "2643",
    "label": "Översättare, tolkar och lingvister m.fl."
  },
  {
    "code": "2651",
    "label": "Bildkonstnärer m.fl."
  },
  {
    "code": "2652",
    "label": "Musiker, sångare och kompositörer"
  },
  {
    "code": "2653",
    "label": "Koreografer och dansare"
  },
  {
    "code": "2654",
    "label": "Regissörer och producenter av film, teater m.m."
  },
  {
    "code": "2655",
    "label": "Skådespelare"
  },
  {
    "code": "2661",
    "label": "Socialsekreterare"
  },
  {
    "code": "2662",
    "label": "Kuratorer"
  },
  {
    "code": "2663",
    "label": "Biståndsbedömare m.fl."
  },
  {
    "code": "2669",
    "label": "Övriga yrken inom socialt arbete"
  },
  {
    "code": "2671",
    "label": "Präster"
  },
  {
    "code": "2672",
    "label": "Diakoner"
  },
  {
    "code": "3111",
    "label": "Ingenjörer och tekniker inom industri, logistik och produktionsplanering"
  },
  {
    "code": "3112",
    "label": "Ingenjörer och tekniker inom bygg och anläggning"
  },
  {
    "code": "3113",
    "label": "Ingenjörer och tekniker inom elektroteknik"
  },
  {
    "code": "3114",
    "label": "Ingenjörer och tekniker inom maskinteknik"
  },
  {
    "code": "3115",
    "label": "Ingenjörer och tekniker inom kemi och kemiteknik"
  },
  {
    "code": "3116",
    "label": "Ingenjörer och tekniker inom gruvteknik och metallurgi"
  },
  {
    "code": "3117",
    "label": "GIS- och kartingenjörer"
  },
  {
    "code": "3119",
    "label": "Övriga ingenjörer och tekniker"
  },
  {
    "code": "3121",
    "label": "Arbetsledare inom bygg, anläggning och gruva"
  },
  {
    "code": "3122",
    "label": "Arbetsledare inom tillverkning"
  },
  {
    "code": "3151",
    "label": "Maskinbefäl"
  },
  {
    "code": "3152",
    "label": "Fartygsbefäl m.fl."
  },
  {
    "code": "3153",
    "label": "Piloter m.fl."
  },
  {
    "code": "3154",
    "label": "Flygledare"
  },
  {
    "code": "3155",
    "label": "Flygtekniker"
  },
  {
    "code": "3211",
    "label": "Tekniker, bilddiagnostik och medicinteknisk utrustning"
  },
  {
    "code": "3212",
    "label": "Biomedicinska analytiker m.fl."
  },
  {
    "code": "3213",
    "label": "Receptarier"
  },
  {
    "code": "3214",
    "label": "Tandtekniker och ortopedingenjörer m.fl."
  },
  {
    "code": "3215",
    "label": "Laboratorieingenjörer"
  },
  {
    "code": "3230",
    "label": "Terapeuter inom alternativmedicin"
  },
  {
    "code": "3240",
    "label": "Djursjukskötare m.fl."
  },
  {
    "code": "3250",
    "label": "Tandhygienister"
  },
  {
    "code": "3311",
    "label": "Mäklare inom finans"
  },
  {
    "code": "3312",
    "label": "Banktjänstemän"
  },
  {
    "code": "3313",
    "label": "Redovisningsekonomer"
  },
  {
    "code": "3314",
    "label": "Skadereglerare och värderare"
  },
  {
    "code": "3321",
    "label": "Försäkringssäljare och försäkringsrådgivare"
  },
  {
    "code": "3322",
    "label": "Företagssäljare"
  },
  {
    "code": "3323",
    "label": "Inköpare och upphandlare"
  },
  {
    "code": "3324",
    "label": "Ordersamordnare m.fl."
  },
  {
    "code": "3331",
    "label": "Speditörer och transportmäklare"
  },
  {
    "code": "3332",
    "label": "Evenemangs- och reseproducenter m.fl."
  },
  {
    "code": "3333",
    "label": "Arbetsförmedlare"
  },
  {
    "code": "3334",
    "label": "Fastighetsmäklare"
  },
  {
    "code": "3335",
    "label": "Fastighetsförvaltare"
  },
  {
    "code": "3339",
    "label": "Övriga förmedlare"
  },
  {
    "code": "3341",
    "label": "Gruppledare för kontorspersonal"
  },
  {
    "code": "3342",
    "label": "Domstols- och juristsekreterare m.fl."
  },
  {
    "code": "3343",
    "label": "Chefssekreterare och VD-assistenter m.fl."
  },
  {
    "code": "3351",
    "label": "Tull- och kustbevakningstjänstemän"
  },
  {
    "code": "3352",
    "label": "Skattehandläggare"
  },
  {
    "code": "3353",
    "label": "Socialförsäkringshandläggare"
  },
  {
    "code": "3354",
    "label": "Säkerhetsinspektörer m.fl."
  },
  {
    "code": "3355",
    "label": "Brandingenjörer och byggnadsinspektörer m.fl."
  },
  {
    "code": "3359",
    "label": "Övriga handläggare"
  },
  {
    "code": "3360",
    "label": "Poliser"
  },
  {
    "code": "3411",
    "label": "Behandlingsassistenter och socialpedagoger m.fl."
  },
  {
    "code": "3412",
    "label": "Pastorer m.fl."
  },
  {
    "code": "3421",
    "label": "Professionella idrottsutövare"
  },
  {
    "code": "3422",
    "label": "Idrottstränare och instruktörer m.fl."
  },
  {
    "code": "3423",
    "label": "Fritidsledare m.fl."
  },
  {
    "code": "3424",
    "label": "Friskvårdskonsulenter och hälsopedagoger m.fl."
  },
  {
    "code": "3431",
    "label": "Fotografer"
  },
  {
    "code": "3432",
    "label": "Inredare, dekoratörer och scenografer m.fl."
  },
  {
    "code": "3433",
    "label": "Inspicienter och scriptor m.fl."
  },
  {
    "code": "3439",
    "label": "Övriga yrken inom kultur och underhållning"
  },
  {
    "code": "3441",
    "label": "Trafiklärare"
  },
  {
    "code": "3449",
    "label": "Övriga utbildare och instruktörer"
  },
  {
    "code": "3451",
    "label": "Köksmästare och souschefer"
  },
  {
    "code": "3452",
    "label": "Storhushållsföreståndare"
  },
  {
    "code": "3511",
    "label": "Drifttekniker, IT"
  },
  {
    "code": "3512",
    "label": "Supporttekniker, IT"
  },
  {
    "code": "3513",
    "label": "Systemadministratörer"
  },
  {
    "code": "3514",
    "label": "Nätverks- och systemtekniker m.fl."
  },
  {
    "code": "3515",
    "label": "Webbmaster och webbadministratörer"
  },
  {
    "code": "3521",
    "label": "Bild- och sändningstekniker"
  },
  {
    "code": "3522",
    "label": "Ljus-, ljud och scentekniker"
  },
  {
    "code": "4111",
    "label": "Ekonomiassistenter m.fl."
  },
  {
    "code": "4112",
    "label": "Löne- och personaladministratörer"
  },
  {
    "code": "4113",
    "label": "Backofficepersonal m.fl."
  },
  {
    "code": "4114",
    "label": "Marknads- och försäljningsassistenter"
  },
  {
    "code": "4115",
    "label": "Inköps- och orderassistenter"
  },
  {
    "code": "4116",
    "label": "Skolassistenter m.fl."
  },
  {
    "code": "4117",
    "label": "Medicinska sekreterare, vårdadministratörer m.fl."
  },
  {
    "code": "4119",
    "label": "Övriga kontorsassistenter och sekreterare"
  },
  {
    "code": "4211",
    "label": "Croupierer och oddssättare m.fl."
  },
  {
    "code": "4212",
    "label": "Inkasserare och pantlånare m.fl."
  },
  {
    "code": "4221",
    "label": "Resesäljare och trafikassistenter m.fl."
  },
  {
    "code": "4222",
    "label": "Kundtjänstpersonal"
  },
  {
    "code": "4223",
    "label": "Telefonister"
  },
  {
    "code": "4224",
    "label": "Hotellreceptionister m.fl."
  },
  {
    "code": "4225",
    "label": "Kontorsreceptionister"
  },
  {
    "code": "4226",
    "label": "Marknadsundersökare och intervjuare"
  },
  {
    "code": "4321",
    "label": "Arbetsledare inom lager och terminal"
  },
  {
    "code": "4322",
    "label": "Lager- och terminalpersonal"
  },
  {
    "code": "4323",
    "label": "Transportledare och transportsamordnare"
  },
  {
    "code": "4410",
    "label": "Biblioteks- och arkivassistenter m.fl."
  },
  {
    "code": "4420",
    "label": "Brevbärare och postterminalarbetare"
  },
  {
    "code": "4430",
    "label": "Förtroendevalda"
  },
  {
    "code": "5111",
    "label": "Kabinpersonal m.fl."
  },
  {
    "code": "5112",
    "label": "Tågvärdar och ombordansvariga m.fl."
  },
  {
    "code": "5113",
    "label": "Guider och reseledare"
  },
  {
    "code": "5120",
    "label": "Kockar och kallskänkor"
  },
  {
    "code": "5131",
    "label": "Hovmästare och servitörer"
  },
  {
    "code": "5132",
    "label": "Bartendrar"
  },
  {
    "code": "5141",
    "label": "Frisörer"
  },
  {
    "code": "5142",
    "label": "Hudterapeuter"
  },
  {
    "code": "5143",
    "label": "Massörer och massageterapeuter"
  },
  {
    "code": "5144",
    "label": "Fotterapeuter"
  },
  {
    "code": "5149",
    "label": "Övriga skönhets- och kroppsterapeuter"
  },
  {
    "code": "5151",
    "label": "Städledare och husfruar"
  },
  {
    "code": "5152",
    "label": "Fastighetsskötare"
  },
  {
    "code": "5161",
    "label": "Begravnings- och krematoriepersonal"
  },
  {
    "code": "5169",
    "label": "Övrig servicepersonal"
  },
  {
    "code": "5221",
    "label": "Säljande butikschefer och avdelningschefer i butik"
  },
  {
    "code": "5222",
    "label": "Butikssäljare, dagligvaror"
  },
  {
    "code": "5223",
    "label": "Butikssäljare, fackhandel"
  },
  {
    "code": "5224",
    "label": "Optikerassistenter"
  },
  {
    "code": "5225",
    "label": "Bensinstationspersonal"
  },
  {
    "code": "5226",
    "label": "Uthyrare"
  },
  {
    "code": "5227",
    "label": "Apotekstekniker"
  },
  {
    "code": "5230",
    "label": "Kassapersonal m.fl."
  },
  {
    "code": "5241",
    "label": "Eventsäljare och butiksdemonstratörer m.fl."
  },
  {
    "code": "5242",
    "label": "Telefonförsäljare m.fl."
  },
  {
    "code": "5311",
    "label": "Barnskötare"
  },
  {
    "code": "5312",
    "label": "Elevassistenter m.fl."
  },
  {
    "code": "5321",
    "label": "Undersköterskor, hemtjänst, hemsjukvård och äldreboende"
  },
  {
    "code": "5322",
    "label": "Undersköterskor, habilitering"
  },
  {
    "code": "5323",
    "label": "Undersköterskor, vård- och specialavdelning"
  },
  {
    "code": "5324",
    "label": "Undersköterskor, mottagning"
  },
  {
    "code": "5325",
    "label": "Barnsköterskor"
  },
  {
    "code": "5326",
    "label": "Ambulanssjukvårdare"
  },
  {
    "code": "5330",
    "label": "Vårdbiträden"
  },
  {
    "code": "5341",
    "label": "Skötare"
  },
  {
    "code": "5342",
    "label": "Vårdare, boendestödjare"
  },
  {
    "code": "5343",
    "label": "Personliga assistenter"
  },
  {
    "code": "5349",
    "label": "Övrig vård- och omsorgspersonal"
  },
  {
    "code": "5350",
    "label": "Tandsköterskor"
  },
  {
    "code": "5411",
    "label": "Brandmän"
  },
  {
    "code": "5412",
    "label": "Kriminalvårdare"
  },
  {
    "code": "5413",
    "label": "Väktare och ordningsvakter"
  },
  {
    "code": "5414",
    "label": "SOS-operatörer m.fl."
  },
  {
    "code": "5419",
    "label": "Övrig bevaknings- och säkerhetspersonal"
  },
  {
    "code": "6111",
    "label": "Odlare av jordbruksväxter, frukt- och bär"
  },
  {
    "code": "6112",
    "label": "Trädgårdsodlare"
  },
  {
    "code": "6113",
    "label": "Trädgårdsanläggare m.fl."
  },
  {
    "code": "6121",
    "label": "Uppfödare och skötare av lantbrukets husdjur"
  },
  {
    "code": "6122",
    "label": "Uppfödare och skötare av sällskapsdjur"
  },
  {
    "code": "6129",
    "label": "Övriga djuruppfödare och djurskötare"
  },
  {
    "code": "6130",
    "label": "Växtodlare och djuruppfödare, blandad drift"
  },
  {
    "code": "6210",
    "label": "Skogsarbetare"
  },
  {
    "code": "6221",
    "label": "Fiskodlare"
  },
  {
    "code": "6222",
    "label": "Fiskare"
  },
  {
    "code": "7111",
    "label": "Träarbetare, snickare m.fl."
  },
  {
    "code": "7112",
    "label": "Murare m.fl."
  },
  {
    "code": "7113",
    "label": "Betongarbetare"
  },
  {
    "code": "7114",
    "label": "Anläggningsarbetare"
  },
  {
    "code": "7115",
    "label": "Anläggningsdykare"
  },
  {
    "code": "7116",
    "label": "Ställningsbyggare"
  },
  {
    "code": "7119",
    "label": "Övriga byggnads- och anläggningsarbetare"
  },
  {
    "code": "7121",
    "label": "Takmontörer"
  },
  {
    "code": "7122",
    "label": "Golvläggare"
  },
  {
    "code": "7123",
    "label": "Isoleringsmontörer"
  },
  {
    "code": "7124",
    "label": "Glastekniker"
  },
  {
    "code": "7125",
    "label": "VVS-montörer m.fl."
  },
  {
    "code": "7126",
    "label": "Kyl- och värmepumpstekniker m.fl."
  },
  {
    "code": "7131",
    "label": "Målare"
  },
  {
    "code": "7132",
    "label": "Lackerare och industrimålare"
  },
  {
    "code": "7133",
    "label": "Skorstensfejare"
  },
  {
    "code": "7134",
    "label": "Saneringsarbetare m.fl."
  },
  {
    "code": "7211",
    "label": "Gjutare"
  },
  {
    "code": "7212",
    "label": "Svetsare och gasskärare"
  },
  {
    "code": "7213",
    "label": "Byggnads- och ventilationsplåtslagare"
  },
  {
    "code": "7214",
    "label": "Tunnplåtslagare"
  },
  {
    "code": "7215",
    "label": "Stålkonstruktionsmontörer och grovplåtsslagare"
  },
  {
    "code": "7221",
    "label": "Smeder"
  },
  {
    "code": "7222",
    "label": "Verktygsmakare"
  },
  {
    "code": "7223",
    "label": "Maskinställare och maskinoperatörer, metallarbete"
  },
  {
    "code": "7224",
    "label": "Slipare m.fl."
  },
  {
    "code": "7231",
    "label": "Motorfordonsmekaniker och fordonsreparatörer"
  },
  {
    "code": "7232",
    "label": "Flygmekaniker m.fl."
  },
  {
    "code": "7233",
    "label": "Underhållsmekaniker och maskinreparatörer"
  },
  {
    "code": "7311",
    "label": "Finmekaniker"
  },
  {
    "code": "7312",
    "label": "Guld- och silversmeder"
  },
  {
    "code": "7319",
    "label": "Musikinstrumentmakare och övriga konsthantverkare"
  },
  {
    "code": "7321",
    "label": "Prepresstekniker"
  },
  {
    "code": "7322",
    "label": "Tryckare"
  },
  {
    "code": "7323",
    "label": "Bokbindare m.fl."
  },
  {
    "code": "7411",
    "label": "Installations- och serviceelektriker"
  },
  {
    "code": "7412",
    "label": "Industrielektriker"
  },
  {
    "code": "7413",
    "label": "Distributionselektriker"
  },
  {
    "code": "7420",
    "label": "Elektronikreparatörer och kommunikationselektriker m.fl."
  },
  {
    "code": "7521",
    "label": "Manuella ytbehandlare, trä"
  },
  {
    "code": "7522",
    "label": "Fin-, inrednings- och möbelsnickare"
  },
  {
    "code": "7523",
    "label": "Maskinsnickare och maskinoperatörer, träindustri"
  },
  {
    "code": "7531",
    "label": "Skräddare och ateljésömmerskor m.fl."
  },
  {
    "code": "7532",
    "label": "Sömmare"
  },
  {
    "code": "7533",
    "label": "Tapetserare"
  },
  {
    "code": "7534",
    "label": "Läderhantverkare och skomakare"
  },
  {
    "code": "7611",
    "label": "Slaktare och styckare m.fl."
  },
  {
    "code": "7612",
    "label": "Bagare och konditorer"
  },
  {
    "code": "7613",
    "label": "Provsmakare och kvalitetsbedömare"
  },
  {
    "code": "7619",
    "label": "Övriga livsmedelsförädlare"
  },
  {
    "code": "8111",
    "label": "Gruv- och stenbrottsarbetare"
  },
  {
    "code": "8112",
    "label": "Processoperatörer, stenkross- och malmförädlingsanläggning"
  },
  {
    "code": "8113",
    "label": "Brunnsborrare m.fl."
  },
  {
    "code": "8114",
    "label": "Maskinoperatörer, cement-, sten- och betongvaror"
  },
  {
    "code": "8115",
    "label": "Bergssprängare"
  },
  {
    "code": "8116",
    "label": "Stenhuggare m.fl."
  },
  {
    "code": "8121",
    "label": "Maskinoperatörer, ytbehandling"
  },
  {
    "code": "8122",
    "label": "Valsverksoperatörer"
  },
  {
    "code": "8129",
    "label": "Övriga maskin- och processoperatörer vid stål- och metallverk"
  },
  {
    "code": "8131",
    "label": "Maskinoperatörer, farmaceutiska produkter"
  },
  {
    "code": "8132",
    "label": "Maskinoperatörer, kemisktekniska och fotografiska produkter"
  },
  {
    "code": "8141",
    "label": "Maskinoperatörer, gummiindustri"
  },
  {
    "code": "8142",
    "label": "Maskinoperatörer, plastindustri"
  },
  {
    "code": "8143",
    "label": "Maskinoperatörer, pappersvaruindustri"
  },
  {
    "code": "8151",
    "label": "Maskinoperatörer, blekning, färgning och tvättning"
  },
  {
    "code": "8159",
    "label": "Övriga maskinoperatörer, textil-, skinn- och läderindustri"
  },
  {
    "code": "8161",
    "label": "Maskinoperatörer, kött- och fiskberedningsindustri"
  },
  {
    "code": "8162",
    "label": "Maskinoperatörer, mejeri"
  },
  {
    "code": "8163",
    "label": "Maskinoperatörer, kvarn-, bageri- och konfektyrindustri"
  },
  {
    "code": "8169",
    "label": "Övriga maskinoperatörer inom livsmedelsindustri m.m."
  },
  {
    "code": "8171",
    "label": "Processoperatörer, pappersmassa"
  },
  {
    "code": "8172",
    "label": "Processoperatörer, papper"
  },
  {
    "code": "8173",
    "label": "Operatörer inom sågverk, hyvleri och plywood m.m."
  },
  {
    "code": "8174",
    "label": "Maskinoperatörer inom ytbehandling, trä"
  },
  {
    "code": "8181",
    "label": "Maskinoperatörer, påfyllning, packning och märkning"
  },
  {
    "code": "8189",
    "label": "Andra process- och maskinoperatörer"
  },
  {
    "code": "8191",
    "label": "Drifttekniker vid värme- och vattenverk"
  },
  {
    "code": "8192",
    "label": "Processövervakare, kemisk industri"
  },
  {
    "code": "8193",
    "label": "Processövervakare, metallproduktion"
  },
  {
    "code": "8199",
    "label": "Övriga drifttekniker och processövervakare"
  },
  {
    "code": "8211",
    "label": "Fordonsmontörer"
  },
  {
    "code": "8212",
    "label": "Montörer, elektrisk och elektronisk utrustning"
  },
  {
    "code": "8213",
    "label": "Montörer, metall-, gummi- och plastprodukter"
  },
  {
    "code": "8214",
    "label": "Montörer, träprodukter"
  },
  {
    "code": "8219",
    "label": "Övriga montörer"
  },
  {
    "code": "8311",
    "label": "Lokförare"
  },
  {
    "code": "8312",
    "label": "Bangårdspersonal"
  },
  {
    "code": "8321",
    "label": "Taxiförare m.fl."
  },
  {
    "code": "8329",
    "label": "Övriga bil-, motorcykel- och cykelförare"
  },
  {
    "code": "8331",
    "label": "Buss- och spårvagnsförare"
  },
  {
    "code": "8332",
    "label": "Lastbilsförare m.fl."
  },
  {
    "code": "8341",
    "label": "Förare av jordbruks- och skogsmaskiner"
  },
  {
    "code": "8342",
    "label": "Anläggningsmaskinförare m.fl."
  },
  {
    "code": "8343",
    "label": "Kranförare m.fl."
  },
  {
    "code": "8344",
    "label": "Truckförare"
  },
  {
    "code": "8350",
    "label": "Matroser och jungmän m.fl."
  },
  {
    "code": "9111",
    "label": "Städare"
  },
  {
    "code": "9119",
    "label": "Övrig hemservicepersonal m.fl."
  },
  {
    "code": "9120",
    "label": "Bilrekonditionerare, fönsterputsare och övriga rengöringsarbetare"
  },
  {
    "code": "9210",
    "label": "Bärplockare och plantörer m.fl."
  },
  {
    "code": "9310",
    "label": "Grovarbetare inom bygg och anläggning"
  },
  {
    "code": "9320",
    "label": "Handpaketerare och andra fabriksarbetare"
  },
  {
    "code": "9331",
    "label": "Hamnarbetare"
  },
  {
    "code": "9332",
    "label": "Ramppersonal, flyttkarlar och varupåfyllare m.fl."
  },
  {
    "code": "9411",
    "label": "Pizzabagare m.fl."
  },
  {
    "code": "9412",
    "label": "Restaurang- och köksbiträden m.fl."
  },
  {
    "code": "9413",
    "label": "Kafé- och konditoribiträden"
  },
  {
    "code": "9520",
    "label": "Torg- och marknadsförsäljare"
  },
  {
    "code": "9610",
    "label": "Renhållnings- och återvinningsarbetare"
  },
  {
    "code": "9621",
    "label": "Reklamutdelare och tidningsdistributörer"
  },
  {
    "code": "9622",
    "label": "Vaktmästare m.fl."
  },
  {
    "code": "9629",
    "label": "Övriga servicearbetare"
  }
]

const SSYK_BY_CODE: Map<string, string> = new Map(SSYK_CODES.map((c) => [c.code, c.label]))

/** Look up the occupation title for a 4-digit SSYK code, or null if unknown. */
export function findSsykLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return SSYK_BY_CODE.get(code.trim()) ?? null
}

