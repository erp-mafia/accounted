/**
 * Counterpart resolver: the seed of the shared brand directory.
 *
 * Half of all outgoing bank rows across the fleet carry a key seen in three
 * or more companies (read-only count, 2026-09-08). These are the names behind
 * those keys, written once so no company and no model call has to work them
 * out again. Matching is on whole tokens of the pre-cleaned string, longest
 * pattern first, so "apple.com/bill" wins over "apple" and "sl" never fires
 * inside "slack".
 *
 * Brand level only: a merchant, an authority, a bank or a payment rail. A rail
 * is what the money passed through (Klarna, PayPal, Stripe, Zettle); when the
 * string names no sub-merchant the rail is the counterpart that appears.
 * Persons never belong here. The DB table counterparty_directory extends this
 * list with readings promoted from two or more companies.
 */

export type DirectoryKind = 'merchant' | 'authority' | 'bank' | 'rail'

export interface DirectoryEntry {
  /** Whole-token patterns against the pre-cleaned lowercase string. */
  patterns: readonly string[]
  /** Bankgiro or plusgiro numbers that identify the payee outright. */
  giro?: readonly string[]
  name: string
  kind: DirectoryKind
  country?: string
  /** Swedish, 2 to 6 words: what the counterpart sells. */
  what?: string
  logoDomain?: string
}

export const DIRECTORY_SEED: readonly DirectoryEntry[] = [
  // Authorities and public bodies
  { patterns: ['skatteverket', 'skatteverk', 'skatteverket skatt', 'skatteverket moms', 'skv'], giro: ['5050-1055'], name: 'Skatteverket', kind: 'authority', country: 'SE', what: 'Skatter och avgifter', logoDomain: 'skatteverket.se' },
  { patterns: ['bolagsverket'], name: 'Bolagsverket', kind: 'authority', country: 'SE', what: 'Registreringsavgifter', logoDomain: 'bolagsverket.se' },
  { patterns: ['transportstyrelsen', 'transportstyrels', 'transportstyrelsen fordon'], name: 'Transportstyrelsen', kind: 'authority', country: 'SE', what: 'Fordonsskatt och avgifter', logoDomain: 'transportstyrelsen.se' },
  { patterns: ['forsakringskassan', 'försäkringskassan'], name: 'Försäkringskassan', kind: 'authority', country: 'SE', logoDomain: 'forsakringskassan.se' },
  { patterns: ['kronofogden'], name: 'Kronofogden', kind: 'authority', country: 'SE', logoDomain: 'kronofogden.se' },
  { patterns: ['tullverket'], name: 'Tullverket', kind: 'authority', country: 'SE', what: 'Tull och importmoms', logoDomain: 'tullverket.se' },
  { patterns: ['prv'], name: 'Patent- och registreringsverket', kind: 'authority', country: 'SE', logoDomain: 'prv.se' },

  // Payment rails and marketplaces
  { patterns: ['klarna', 'klarna ab', 'klarna bank'], name: 'Klarna', kind: 'rail', country: 'SE', what: 'Betalningar och fakturaköp', logoDomain: 'klarna.com' },
  { patterns: ['paypal', 'paypal europe'], name: 'PayPal', kind: 'rail', what: 'Betalningar', logoDomain: 'paypal.com' },
  { patterns: ['stripe', 'stripe payments'], name: 'Stripe', kind: 'rail', what: 'Kortinlösen och avgifter', logoDomain: 'stripe.com' },
  { patterns: ['zettle', 'izettle', 'zettle by paypal'], name: 'Zettle', kind: 'rail', country: 'SE', what: 'Kortterminal och avgifter', logoDomain: 'zettle.com' },
  { patterns: ['swish'], name: 'Swish', kind: 'rail', country: 'SE', what: 'Betalningar', logoDomain: 'swish.nu' },
  { patterns: ['bankgirot', 'bankgiro'], name: 'Bankgirot', kind: 'rail', country: 'SE', logoDomain: 'bankgirot.se' },
  { patterns: ['paddle', 'paddle.net', 'paddle.com'], name: 'Paddle', kind: 'rail', country: 'GB', what: 'Betalningar för mjukvara', logoDomain: 'paddle.com' },
  { patterns: ['shopify', 'shopify payments'], name: 'Shopify', kind: 'rail', what: 'E-handelsplattform', logoDomain: 'shopify.com' },
  { patterns: ['qliro', 'qliro ab'], name: 'Qliro', kind: 'rail', country: 'SE', what: 'Betalningar och fakturaköp', logoDomain: 'qliro.com' },
  { patterns: ['svea', 'svea bank', 'svea ekonomi', 'svea inkasso'], name: 'Svea', kind: 'rail', country: 'SE', what: 'Fakturaköp och inkasso', logoDomain: 'svea.com' },
  { patterns: ['trustly'], name: 'Trustly', kind: 'rail', country: 'SE', logoDomain: 'trustly.com' },
  { patterns: ['wise', 'wise charges', 'transferwise'], name: 'Wise', kind: 'bank', country: 'GB', what: 'Valutaväxling och avgifter', logoDomain: 'wise.com' },
  { patterns: ['revolut'], name: 'Revolut', kind: 'bank', country: 'GB', logoDomain: 'revolut.com' },
  { patterns: ['lunar', 'lunar plan', 'lunar bank'], name: 'Lunar', kind: 'bank', country: 'DK', what: 'Bankavgifter', logoDomain: 'lunar.app' },
  { patterns: ['mynt', 'mynt ab'], name: 'Mynt', kind: 'bank', country: 'SE', what: 'Företagskort', logoDomain: 'mynt.com' },
  { patterns: ['pleo'], name: 'Pleo', kind: 'bank', country: 'DK', what: 'Företagskort', logoDomain: 'pleo.io' },
  { patterns: ['fortnox finans', 'fortnox finans ab'], name: 'Fortnox Finans', kind: 'bank', country: 'SE', what: 'Fakturaköp och finansiering', logoDomain: 'fortnox.se' },

  // Software and cloud
  { patterns: ['anthropic', 'anthropic claude', 'claude', 'claude sub', 'claude.ai'], name: 'Anthropic', kind: 'merchant', country: 'US', what: 'AI-assistent (Claude), SaaS', logoDomain: 'anthropic.com' },
  { patterns: ['openai', 'openai chatgpt', 'chatgpt', 'chatgpt subscr'], name: 'OpenAI', kind: 'merchant', country: 'US', what: 'AI-assistent (ChatGPT), SaaS', logoDomain: 'openai.com' },
  { patterns: ['lovable'], name: 'Lovable', kind: 'merchant', country: 'SE', what: 'AI-utvecklingsverktyg, SaaS', logoDomain: 'lovable.dev' },
  { patterns: ['cursor', 'cursor ai', 'anysphere'], name: 'Cursor', kind: 'merchant', country: 'US', what: 'AI-kodredigerare, SaaS', logoDomain: 'cursor.com' },
  { patterns: ['github', 'github inc'], name: 'GitHub', kind: 'merchant', country: 'US', what: 'Kodhosting, SaaS', logoDomain: 'github.com' },
  { patterns: ['google workspace', 'google gsuite', 'gsuite'], name: 'Google Workspace', kind: 'merchant', country: 'IE', what: 'E-post och kontorsprogram, SaaS', logoDomain: 'google.com' },
  { patterns: ['google cloud', 'google cloud emea'], name: 'Google Cloud', kind: 'merchant', country: 'IE', what: 'Molntjänster', logoDomain: 'cloud.google.com' },
  { patterns: ['google ads', 'google adwords', 'googleads'], name: 'Google Ads', kind: 'merchant', country: 'IE', what: 'Annonsering', logoDomain: 'ads.google.com' },
  { patterns: ['google one', 'google play', 'google youtube', 'youtube premium', 'youtubepremium', 'google'], name: 'Google', kind: 'merchant', country: 'IE', what: 'Molntjänster och annonser', logoDomain: 'google.com' },
  { patterns: ['microsoft', 'msbill.info', 'microsoft azure', 'azure'], name: 'Microsoft', kind: 'merchant', country: 'IE', what: 'Programvara och molntjänster', logoDomain: 'microsoft.com' },
  { patterns: ['apple.com/bill', 'apple.combill', 'applecombill', 'apple com bill', 'apple'], name: 'Apple', kind: 'merchant', country: 'IE', what: 'Appar, prenumerationer och hårdvara', logoDomain: 'apple.com' },
  { patterns: ['amazon web services', 'aws emea', 'aws', 'amazon aws'], name: 'Amazon Web Services', kind: 'merchant', country: 'LU', what: 'Molntjänster', logoDomain: 'aws.amazon.com' },
  { patterns: ['amazon', 'amazon se', 'amazon.se', 'amzn mktp', 'amznmktplc', 'amazonmktplc', 'amazon eu', 'amazon prime'], name: 'Amazon', kind: 'merchant', country: 'LU', what: 'Näthandel', logoDomain: 'amazon.se' },
  { patterns: ['adobe', 'adobe systems', 'adobe inc'], name: 'Adobe', kind: 'merchant', country: 'IE', what: 'Kreativ programvara, SaaS', logoDomain: 'adobe.com' },
  { patterns: ['figma'], name: 'Figma', kind: 'merchant', country: 'US', what: 'Designverktyg, SaaS', logoDomain: 'figma.com' },
  { patterns: ['canva'], name: 'Canva', kind: 'merchant', country: 'AU', what: 'Designverktyg, SaaS', logoDomain: 'canva.com' },
  { patterns: ['notion', 'notion labs'], name: 'Notion', kind: 'merchant', country: 'US', what: 'Dokument och planering, SaaS', logoDomain: 'notion.so' },
  { patterns: ['slack', 'slack technologies'], name: 'Slack', kind: 'merchant', country: 'IE', what: 'Teamchatt, SaaS', logoDomain: 'slack.com' },
  { patterns: ['zoom', 'zoom.us', 'zoom video'], name: 'Zoom', kind: 'merchant', country: 'US', what: 'Videomöten, SaaS', logoDomain: 'zoom.us' },
  { patterns: ['linkedin', 'linkedin pre', 'linkedin premium'], name: 'LinkedIn', kind: 'merchant', country: 'IE', what: 'Rekrytering och annonsering', logoDomain: 'linkedin.com' },
  { patterns: ['facebk', 'facebook', 'meta platforms', 'meta ads', 'fb ads', 'meta'], name: 'Meta', kind: 'merchant', country: 'IE', what: 'Annonsering (Facebook, Instagram)', logoDomain: 'meta.com' },
  { patterns: ['reddit', 'reddit nl ads'], name: 'Reddit', kind: 'merchant', country: 'NL', what: 'Annonsering', logoDomain: 'reddit.com' },
  { patterns: ['x corp', 'twitter'], name: 'X', kind: 'merchant', country: 'IE', what: 'Annonsering och prenumeration', logoDomain: 'x.com' },
  { patterns: ['dropbox'], name: 'Dropbox', kind: 'merchant', country: 'IE', what: 'Fillagring, SaaS', logoDomain: 'dropbox.com' },
  { patterns: ['atlassian'], name: 'Atlassian', kind: 'merchant', country: 'AU', what: 'Utvecklarverktyg (Jira), SaaS', logoDomain: 'atlassian.com' },
  { patterns: ['jetbrains'], name: 'JetBrains', kind: 'merchant', country: 'CZ', what: 'Utvecklarverktyg, SaaS', logoDomain: 'jetbrains.com' },
  { patterns: ['digitalocean'], name: 'DigitalOcean', kind: 'merchant', country: 'US', what: 'Molnservrar', logoDomain: 'digitalocean.com' },
  { patterns: ['hetzner', 'hetzner online'], name: 'Hetzner', kind: 'merchant', country: 'DE', what: 'Servrar och hosting', logoDomain: 'hetzner.com' },
  { patterns: ['vercel', 'vercel inc'], name: 'Vercel', kind: 'merchant', country: 'US', what: 'Webbhosting, SaaS', logoDomain: 'vercel.com' },
  { patterns: ['netlify'], name: 'Netlify', kind: 'merchant', country: 'US', what: 'Webbhosting, SaaS', logoDomain: 'netlify.com' },
  { patterns: ['railway', 'railway corp'], name: 'Railway', kind: 'merchant', country: 'US', what: 'Apphosting, SaaS', logoDomain: 'railway.app' },
  { patterns: ['supabase'], name: 'Supabase', kind: 'merchant', country: 'US', what: 'Databas och backend, SaaS', logoDomain: 'supabase.com' },
  { patterns: ['cloudflare'], name: 'Cloudflare', kind: 'merchant', country: 'US', what: 'DNS, CDN och säkerhet', logoDomain: 'cloudflare.com' },
  { patterns: ['namecheap', 'name-cheap.com', 'name cheap'], name: 'Namecheap', kind: 'merchant', country: 'US', what: 'Domäner', logoDomain: 'namecheap.com' },
  { patterns: ['godaddy'], name: 'GoDaddy', kind: 'merchant', country: 'US', what: 'Domäner och hosting', logoDomain: 'godaddy.com' },
  { patterns: ['loopia'], name: 'Loopia', kind: 'merchant', country: 'SE', what: 'Domäner och hosting', logoDomain: 'loopia.se' },
  { patterns: ['one.com', 'one com'], name: 'one.com', kind: 'merchant', country: 'DK', what: 'Domäner och hosting', logoDomain: 'one.com' },
  { patterns: ['squarespace', 'sqsp'], name: 'Squarespace', kind: 'merchant', country: 'IE', what: 'Webbplatsbyggare, SaaS', logoDomain: 'squarespace.com' },
  { patterns: ['wix', 'wix.com'], name: 'Wix', kind: 'merchant', country: 'IL', what: 'Webbplatsbyggare, SaaS', logoDomain: 'wix.com' },
  { patterns: ['webflow'], name: 'Webflow', kind: 'merchant', country: 'US', what: 'Webbplatsbyggare, SaaS', logoDomain: 'webflow.com' },
  { patterns: ['framer', 'framer b.v.'], name: 'Framer', kind: 'merchant', country: 'NL', what: 'Webbdesignverktyg, SaaS', logoDomain: 'framer.com' },
  { patterns: ['1password', 'agilebits'], name: '1Password', kind: 'merchant', country: 'CA', what: 'Lösenordshanterare, SaaS', logoDomain: '1password.com' },
  { patterns: ['resend'], name: 'Resend', kind: 'merchant', country: 'US', what: 'E-postutskick via API', logoDomain: 'resend.com' },
  { patterns: ['twilio'], name: 'Twilio', kind: 'merchant', country: 'US', what: 'SMS och telefoni via API', logoDomain: 'twilio.com' },
  { patterns: ['sendgrid'], name: 'SendGrid', kind: 'merchant', country: 'US', what: 'E-postutskick via API', logoDomain: 'sendgrid.com' },
  { patterns: ['mailchimp', 'intuit mailchimp'], name: 'Mailchimp', kind: 'merchant', country: 'US', what: 'Nyhetsbrev, SaaS', logoDomain: 'mailchimp.com' },
  { patterns: ['hubspot'], name: 'HubSpot', kind: 'merchant', country: 'IE', what: 'CRM, SaaS', logoDomain: 'hubspot.com' },
  { patterns: ['pipedrive'], name: 'Pipedrive', kind: 'merchant', country: 'EE', what: 'CRM, SaaS', logoDomain: 'pipedrive.com' },
  { patterns: ['zapier'], name: 'Zapier', kind: 'merchant', country: 'US', what: 'Automatisering, SaaS', logoDomain: 'zapier.com' },
  { patterns: ['elevenlabs'], name: 'ElevenLabs', kind: 'merchant', country: 'US', what: 'AI-röst, SaaS', logoDomain: 'elevenlabs.io' },
  { patterns: ['midjourney'], name: 'Midjourney', kind: 'merchant', country: 'US', what: 'AI-bildgenerering, SaaS', logoDomain: 'midjourney.com' },
  { patterns: ['higgsfield'], name: 'Higgsfield', kind: 'merchant', country: 'US', what: 'AI-videogenerering, SaaS', logoDomain: 'higgsfield.ai' },
  { patterns: ['replit'], name: 'Replit', kind: 'merchant', country: 'US', what: 'Utvecklingsmiljö, SaaS', logoDomain: 'replit.com' },
  { patterns: ['fortnox', 'fortnox ab'], name: 'Fortnox', kind: 'merchant', country: 'SE', what: 'Ekonomiprogram, SaaS', logoDomain: 'fortnox.se' },
  { patterns: ['bokio'], name: 'Bokio', kind: 'merchant', country: 'SE', what: 'Ekonomiprogram, SaaS', logoDomain: 'bokio.se' },
  { patterns: ['visma', 'visma spcs'], name: 'Visma', kind: 'merchant', country: 'SE', what: 'Ekonomiprogram, SaaS', logoDomain: 'visma.se' },
  { patterns: ['bjorn lunden', 'björn lundén', 'bl administration'], name: 'Björn Lundén', kind: 'merchant', country: 'SE', what: 'Ekonomiprogram, SaaS', logoDomain: 'bjornlunden.se' },
  { patterns: ['spotify'], name: 'Spotify', kind: 'merchant', country: 'SE', what: 'Musikströmning', logoDomain: 'spotify.com' },
  { patterns: ['netflix', 'netflix.com'], name: 'Netflix', kind: 'merchant', country: 'NL', what: 'Videoströmning', logoDomain: 'netflix.com' },
  { patterns: ['disney plus', 'disney+', 'disneyplus'], name: 'Disney+', kind: 'merchant', country: 'NL', what: 'Videoströmning', logoDomain: 'disneyplus.com' },

  // Telecom, utilities, insurance
  { patterns: ['telia', 'telia sverige', 'telia company'], name: 'Telia', kind: 'merchant', country: 'SE', what: 'Telefoni och bredband', logoDomain: 'telia.se' },
  { patterns: ['telenor', 'telenor sverige'], name: 'Telenor', kind: 'merchant', country: 'SE', what: 'Telefoni och bredband', logoDomain: 'telenor.se' },
  { patterns: ['tre', 'tre sverige', 'hi3g'], name: 'Tre', kind: 'merchant', country: 'SE', what: 'Mobiltelefoni', logoDomain: 'tre.se' },
  { patterns: ['comviq'], name: 'Comviq', kind: 'merchant', country: 'SE', what: 'Mobiltelefoni', logoDomain: 'comviq.se' },
  { patterns: ['tele2'], name: 'Tele2', kind: 'merchant', country: 'SE', what: 'Telefoni och bredband', logoDomain: 'tele2.se' },
  { patterns: ['bahnhof'], name: 'Bahnhof', kind: 'merchant', country: 'SE', what: 'Bredband', logoDomain: 'bahnhof.se' },
  { patterns: ['vattenfall'], name: 'Vattenfall', kind: 'merchant', country: 'SE', what: 'El', logoDomain: 'vattenfall.se' },
  { patterns: ['fortum'], name: 'Fortum', kind: 'merchant', country: 'SE', what: 'El', logoDomain: 'fortum.se' },
  { patterns: ['eon', 'e.on'], name: 'E.ON', kind: 'merchant', country: 'SE', what: 'El', logoDomain: 'eon.se' },
  { patterns: ['ellevio'], name: 'Ellevio', kind: 'merchant', country: 'SE', what: 'Elnät', logoDomain: 'ellevio.se' },
  { patterns: ['lansforsakringar', 'länsförsäkringar', 'lansforsakri', 'länsförsäkri'], name: 'Länsförsäkringar', kind: 'merchant', country: 'SE', what: 'Försäkring och bank', logoDomain: 'lansforsakringar.se' },
  { patterns: ['trygg-hansa', 'trygg hansa', 'trygghansa'], name: 'Trygg-Hansa', kind: 'merchant', country: 'SE', what: 'Försäkring', logoDomain: 'trygghansa.se' },
  { patterns: ['folksam'], name: 'Folksam', kind: 'merchant', country: 'SE', what: 'Försäkring', logoDomain: 'folksam.se' },
  { patterns: ['if skadeforsakring', 'if skadeförsäkring', 'if forsakring', 'if försäkring'], name: 'If', kind: 'merchant', country: 'SE', what: 'Försäkring', logoDomain: 'if.se' },
  { patterns: ['hedvig'], name: 'Hedvig', kind: 'merchant', country: 'SE', what: 'Försäkring', logoDomain: 'hedvig.com' },
  { patterns: ['unionen'], name: 'Unionen', kind: 'merchant', country: 'SE', what: 'Fackavgift', logoDomain: 'unionen.se' },

  // Retail and everyday
  { patterns: ['clas ohlson'], name: 'Clas Ohlson', kind: 'merchant', country: 'SE', what: 'Hemelektronik och verktyg', logoDomain: 'clasohlson.com' },
  { patterns: ['kjell', 'kjell & company', 'kjell company', 'kjell och company'], name: 'Kjell & Company', kind: 'merchant', country: 'SE', what: 'Elektronik och kablar', logoDomain: 'kjell.com' },
  { patterns: ['elgiganten', 'elgiganten.se'], name: 'Elgiganten', kind: 'merchant', country: 'SE', what: 'Hemelektronik', logoDomain: 'elgiganten.se' },
  { patterns: ['netonnet'], name: 'NetOnNet', kind: 'merchant', country: 'SE', what: 'Hemelektronik', logoDomain: 'netonnet.se' },
  { patterns: ['dustin', 'dustin sverige', 'dustin sverige ab'], name: 'Dustin', kind: 'merchant', country: 'SE', what: 'IT-utrustning', logoDomain: 'dustin.se' },
  { patterns: ['webhallen'], name: 'Webhallen', kind: 'merchant', country: 'SE', what: 'IT och hemelektronik', logoDomain: 'webhallen.com' },
  { patterns: ['inet'], name: 'Inet', kind: 'merchant', country: 'SE', what: 'Datorer och komponenter', logoDomain: 'inet.se' },
  { patterns: ['komplett'], name: 'Komplett', kind: 'merchant', country: 'NO', what: 'IT och hemelektronik', logoDomain: 'komplett.se' },
  { patterns: ['jula', 'jula sverige', 'jula sverige ab'], name: 'Jula', kind: 'merchant', country: 'SE', what: 'Verktyg och förbrukning', logoDomain: 'jula.se' },
  { patterns: ['byggmax'], name: 'Byggmax', kind: 'merchant', country: 'SE', what: 'Byggvaror', logoDomain: 'byggmax.se' },
  { patterns: ['bauhaus'], name: 'Bauhaus', kind: 'merchant', country: 'SE', what: 'Byggvaror', logoDomain: 'bauhaus.se' },
  { patterns: ['hornbach'], name: 'Hornbach', kind: 'merchant', country: 'SE', what: 'Byggvaror', logoDomain: 'hornbach.se' },
  { patterns: ['ikea'], name: 'IKEA', kind: 'merchant', country: 'SE', what: 'Möbler och inredning', logoDomain: 'ikea.com' },
  { patterns: ['jysk'], name: 'JYSK', kind: 'merchant', country: 'DK', what: 'Möbler och inredning', logoDomain: 'jysk.se' },
  { patterns: ['ica', 'ica supermarket', 'ica maxi', 'maxi ica', 'ica kvantum', 'ica nara', 'ica nära'], name: 'ICA', kind: 'merchant', country: 'SE', what: 'Livsmedel', logoDomain: 'ica.se' },
  { patterns: ['coop'], name: 'Coop', kind: 'merchant', country: 'SE', what: 'Livsmedel', logoDomain: 'coop.se' },
  { patterns: ['willys'], name: 'Willys', kind: 'merchant', country: 'SE', what: 'Livsmedel', logoDomain: 'willys.se' },
  { patterns: ['hemkop', 'hemköp'], name: 'Hemköp', kind: 'merchant', country: 'SE', what: 'Livsmedel', logoDomain: 'hemkop.se' },
  { patterns: ['lidl'], name: 'Lidl', kind: 'merchant', country: 'SE', what: 'Livsmedel', logoDomain: 'lidl.se' },
  { patterns: ['systembolaget'], name: 'Systembolaget', kind: 'merchant', country: 'SE', what: 'Alkohol', logoDomain: 'systembolaget.se' },
  { patterns: ['apoteket', 'apoteket ab'], name: 'Apoteket', kind: 'merchant', country: 'SE', what: 'Apotek', logoDomain: 'apoteket.se' },
  { patterns: ['kronans apotek', 'kronans apotek ab'], name: 'Kronans Apotek', kind: 'merchant', country: 'SE', what: 'Apotek', logoDomain: 'kronansapotek.se' },
  { patterns: ['apotek hjartat', 'apotek hjärtat'], name: 'Apotek Hjärtat', kind: 'merchant', country: 'SE', what: 'Apotek', logoDomain: 'apotekhjartat.se' },
  { patterns: ['pressbyran', 'pressbyrån'], name: 'Pressbyrån', kind: 'merchant', country: 'SE', what: 'Kiosk', logoDomain: 'pressbyran.se' },
  { patterns: ['7-eleven', '7 eleven', 'seven eleven'], name: '7-Eleven', kind: 'merchant', country: 'SE', what: 'Kiosk', logoDomain: '7-eleven.se' },
  { patterns: ['espresso house'], name: 'Espresso House', kind: 'merchant', country: 'SE', what: 'Kafé', logoDomain: 'espressohouse.com' },
  { patterns: ['max burgers', 'max burger', 'max hamburgare'], name: 'MAX', kind: 'merchant', country: 'SE', what: 'Restaurang', logoDomain: 'max.se' },
  { patterns: ['mcdonalds', "mcdonald's", 'mcd'], name: "McDonald's", kind: 'merchant', country: 'SE', what: 'Restaurang', logoDomain: 'mcdonalds.com' },
  { patterns: ['foodora', 'foodora ab'], name: 'Foodora', kind: 'merchant', country: 'SE', what: 'Matleverans', logoDomain: 'foodora.se' },
  { patterns: ['wolt'], name: 'Wolt', kind: 'merchant', country: 'FI', what: 'Matleverans', logoDomain: 'wolt.com' },
  { patterns: ['uber eats', 'ubereats'], name: 'Uber Eats', kind: 'merchant', country: 'NL', what: 'Matleverans', logoDomain: 'ubereats.com' },
  { patterns: ['h&m', 'h & m', 'hennes mauritz', 'hennes & mauritz'], name: 'H&M', kind: 'merchant', country: 'SE', what: 'Kläder', logoDomain: 'hm.com' },
  { patterns: ['zalando'], name: 'Zalando', kind: 'merchant', country: 'DE', what: 'Kläder, näthandel', logoDomain: 'zalando.se' },
  { patterns: ['tradera'], name: 'Tradera', kind: 'merchant', country: 'SE', what: 'Auktioner, näthandel', logoDomain: 'tradera.com' },
  { patterns: ['blocket'], name: 'Blocket', kind: 'merchant', country: 'SE', what: 'Annonser, näthandel', logoDomain: 'blocket.se' },
  { patterns: ['vinted'], name: 'Vinted', kind: 'merchant', country: 'LT', what: 'Begagnat, näthandel', logoDomain: 'vinted.se' },
  { patterns: ['temu'], name: 'Temu', kind: 'merchant', country: 'IE', what: 'Näthandel', logoDomain: 'temu.com' },
  { patterns: ['aliexpress'], name: 'AliExpress', kind: 'merchant', country: 'SG', what: 'Näthandel', logoDomain: 'aliexpress.com' },
  { patterns: ['hemtex'], name: 'Hemtex', kind: 'merchant', country: 'SE', what: 'Hemtextil', logoDomain: 'hemtex.se' },
  { patterns: ['vistaprint', 'vistaprint b.v', 'vistaprint b.v.'], name: 'Vistaprint', kind: 'merchant', country: 'NL', what: 'Tryck och profilprodukter', logoDomain: 'vistaprint.se' },
  { patterns: ['printful'], name: 'Printful', kind: 'merchant', country: 'LV', what: 'Print on demand', logoDomain: 'printful.com' },

  // Travel and transport
  { patterns: ['sj', 'sj ab', 'sj app', 'sj.se', 'sj biljetter'], name: 'SJ', kind: 'merchant', country: 'SE', what: 'Tågresor', logoDomain: 'sj.se' },
  { patterns: ['sl', 'sl app', 'storstockholms lokaltrafik'], name: 'SL', kind: 'merchant', country: 'SE', what: 'Kollektivtrafik Stockholm', logoDomain: 'sl.se' },
  { patterns: ['vasttrafik', 'västtrafik'], name: 'Västtrafik', kind: 'merchant', country: 'SE', what: 'Kollektivtrafik Göteborg', logoDomain: 'vasttrafik.se' },
  { patterns: ['skanetrafiken', 'skånetrafiken'], name: 'Skånetrafiken', kind: 'merchant', country: 'SE', what: 'Kollektivtrafik Skåne', logoDomain: 'skanetrafiken.se' },
  { patterns: ['sas', 'scandinavian airlines', 'sas ab'], name: 'SAS', kind: 'merchant', country: 'SE', what: 'Flygresor', logoDomain: 'flysas.com' },
  { patterns: ['norwegian', 'norwegian air'], name: 'Norwegian', kind: 'merchant', country: 'NO', what: 'Flygresor', logoDomain: 'norwegian.com' },
  { patterns: ['ryanair'], name: 'Ryanair', kind: 'merchant', country: 'IE', what: 'Flygresor', logoDomain: 'ryanair.com' },
  { patterns: ['lufthansa', 'lufthan'], name: 'Lufthansa', kind: 'merchant', country: 'DE', what: 'Flygresor', logoDomain: 'lufthansa.com' },
  { patterns: ['flixbus'], name: 'FlixBus', kind: 'merchant', country: 'DE', what: 'Bussresor', logoDomain: 'flixbus.se' },
  { patterns: ['booking.com', 'bkg booking.com', 'bkg hotel at booking', 'hotel at booking.com', 'bkg*booking.com'], name: 'Booking.com', kind: 'merchant', country: 'NL', what: 'Hotellbokning', logoDomain: 'booking.com' },
  { patterns: ['airbnb'], name: 'Airbnb', kind: 'merchant', country: 'IE', what: 'Boende', logoDomain: 'airbnb.com' },
  { patterns: ['scandic'], name: 'Scandic', kind: 'merchant', country: 'SE', what: 'Hotell', logoDomain: 'scandichotels.se' },
  { patterns: ['uber', 'uber trip', 'uber bv', 'help.uber.com'], name: 'Uber', kind: 'merchant', country: 'NL', what: 'Taxi', logoDomain: 'uber.com' },
  { patterns: ['bolt', 'bolt.eu', 'bolt operations'], name: 'Bolt', kind: 'merchant', country: 'EE', what: 'Taxi och elsparkcyklar', logoDomain: 'bolt.eu' },
  { patterns: ['voi', 'voi technology', 'voi se'], name: 'Voi', kind: 'merchant', country: 'SE', what: 'Elsparkcyklar', logoDomain: 'voi.com' },
  { patterns: ['taxi stockholm'], name: 'Taxi Stockholm', kind: 'merchant', country: 'SE', what: 'Taxi', logoDomain: 'taxistockholm.se' },
  { patterns: ['easypark'], name: 'EasyPark', kind: 'merchant', country: 'SE', what: 'Parkering', logoDomain: 'easypark.se' },
  { patterns: ['aimo park', 'aimo'], name: 'Aimo Park', kind: 'merchant', country: 'SE', what: 'Parkering', logoDomain: 'aimopark.se' },
  { patterns: ['q-park', 'qpark'], name: 'Q-Park', kind: 'merchant', country: 'SE', what: 'Parkering', logoDomain: 'q-park.se' },
  { patterns: ['circle k', 'circlek'], name: 'Circle K', kind: 'merchant', country: 'SE', what: 'Drivmedel', logoDomain: 'circlek.se' },
  { patterns: ['preem'], name: 'Preem', kind: 'merchant', country: 'SE', what: 'Drivmedel', logoDomain: 'preem.se' },
  { patterns: ['okq8', 'ok q8'], name: 'OKQ8', kind: 'merchant', country: 'SE', what: 'Drivmedel', logoDomain: 'okq8.se' },
  { patterns: ['st1'], name: 'St1', kind: 'merchant', country: 'SE', what: 'Drivmedel', logoDomain: 'st1.se' },
  { patterns: ['ingo'], name: 'INGO', kind: 'merchant', country: 'SE', what: 'Drivmedel', logoDomain: 'ingo.se' },
  { patterns: ['oresundsbron', 'öresundsbron', 'oresundsbron.com'], name: 'Øresundsbron', kind: 'merchant', country: 'DK', what: 'Broavgift', logoDomain: 'oresundsbron.com' },
  { patterns: ['postnord'], name: 'PostNord', kind: 'merchant', country: 'SE', what: 'Frakt och porto', logoDomain: 'postnord.se' },
  { patterns: ['dhl', 'dhl express', 'dhl freight'], name: 'DHL', kind: 'merchant', country: 'DE', what: 'Frakt', logoDomain: 'dhl.com' },
  { patterns: ['ups'], name: 'UPS', kind: 'merchant', country: 'US', what: 'Frakt', logoDomain: 'ups.com' },
  { patterns: ['fedex'], name: 'FedEx', kind: 'merchant', country: 'US', what: 'Frakt', logoDomain: 'fedex.com' },
  { patterns: ['schenker', 'db schenker'], name: 'DB Schenker', kind: 'merchant', country: 'DE', what: 'Frakt', logoDomain: 'dbschenker.com' },
  { patterns: ['sendify'], name: 'Sendify', kind: 'merchant', country: 'SE', what: 'Fraktbokning', logoDomain: 'sendify.se' },
  { patterns: ['budbee'], name: 'Budbee', kind: 'merchant', country: 'SE', what: 'Leverans', logoDomain: 'budbee.com' },

  // Health and training
  { patterns: ['sats'], name: 'SATS', kind: 'merchant', country: 'NO', what: 'Gym', logoDomain: 'sats.se' },
  { patterns: ['actic'], name: 'Actic', kind: 'merchant', country: 'SE', what: 'Gym', logoDomain: 'actic.se' },
  { patterns: ['nordic wellness'], name: 'Nordic Wellness', kind: 'merchant', country: 'SE', what: 'Gym', logoDomain: 'nordicwellness.se' },
  { patterns: ['friskis', 'friskis & svettis', 'friskis och svettis'], name: 'Friskis & Svettis', kind: 'merchant', country: 'SE', what: 'Gym', logoDomain: 'friskissvettis.se' },
  { patterns: ['roda korset', 'röda korset'], name: 'Röda Korset', kind: 'merchant', country: 'SE', what: 'Gåva, hjälporganisation', logoDomain: 'rodakorset.se' },
]
