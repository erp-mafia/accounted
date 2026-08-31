// AUTO-GENERATED: do not edit. Run `npm run setup:extensions` to regenerate.
import type { ExtensionDefinition } from '../types'

export const EXTENSION_DEFINITIONS: Record<string, ExtensionDefinition[]> = {
  'general': [
    {
          "slug": "calendar",
          "name": "Kalender",
          "sector": "general",
          "category": "operations",
          "icon": "Calendar",
          "dataPattern": "core",
          "description": "Fullständig kalendervy med månads-, vecko- och dagsvisning",
          "longDescription": "Se alla fakturadatum och deadlines i en interaktiv kalender med månads-, vecko- och dagsvy.",
          "readsCoreTables": [
                "invoices",
                "deadlines",
                "customers"
          ]
    },
    {
          "slug": "enable-banking",
          "name": "Bankintegration (PSD2)",
          "sector": "general",
          "category": "import",
          "icon": "Landmark",
          "dataPattern": "manual",
          "description": "Automatisk banktransaktionssynk via PSD2",
          "longDescription": "Koppla ditt bankkonto direkt och synka transaktioner automatiskt via säker PSD2-bankintegration. Stöder de flesta svenska banker.",
          "hasOwnData": true,
          "subscriptionNotice": "Denna integration kräver ett aktivt Enable Banking-abonnemang. Utan abonnemang kommer bankintegration inte att fungera."
    },
    {
          "slug": "email",
          "name": "E-post",
          "sector": "general",
          "category": "operations",
          "icon": "Mail",
          "dataPattern": "core",
          "description": "Skicka fakturor och påminnelser via e-post",
          "longDescription": "Aktiverar e-postfunktioner: skicka fakturor till kunder, automatiska betalningspåminnelser enligt valt schema, och e-postmeddelanden. Kräver ett Resend-konto med verifierad domän eller en egen SMTP-server (EMAIL_PROVIDER=smtp).",
          "readsCoreTables": [
                "invoices",
                "customers",
                "company_settings"
          ]
    },
    {
          "slug": "arcim-migration",
          "name": "Systemmigration",
          "sector": "general",
          "category": "import",
          "icon": "ArrowRightLeft",
          "dataPattern": "manual",
          "description": "Migrera bokföring från Fortnox, Visma, Bokio, Björn Lundén eller Briox",
          "longDescription": "Flytta all bokföringsdata från ditt gamla system till gnubok. Importerar kontoplan, verifikationer, kunder, leverantörer och öppna fakturor automatiskt via säker API-integration direkt med leverantören."
    },
    {
          "slug": "tic",
          "name": "Bolagsuppgifter",
          "sector": "general",
          "category": "import",
          "icon": "Building2",
          "dataPattern": "manual",
          "description": "Hämta företagsinformation automatiskt vid registrering",
          "longDescription": "Fyll i företagsuppgifter automatiskt genom att ange organisationsnummer. Hämtar adress, momsregistrering, F-skattestatus och bankuppgifter från offentliga register via TIC.",
          "hasOwnData": true,
          "quickAction": {
                "label": "Företagsprofil",
                "description": "Visa offentliga uppgifter",
                "icon": "Building2",
                "href": "/e/general/tic",
                "order": 10
          }
    },
    {
          "slug": "mcp-server",
          "name": "MCP-server (API)",
          "sector": "general",
          "category": "operations",
          "icon": "Terminal",
          "dataPattern": "manual",
          "description": "Gör bokföring via Claude, Cursor eller annan MCP-klient",
          "longDescription": "Exponerar Accounteds bokföringsmotor som MCP-verktyg (Model Context Protocol). Koppla din MCP-klient med en API-nyckel och gör bokföring genom konversation: visa okategoriserade transaktioner, bokför dem, skapa fakturor."
    },
    {
          "slug": "cloud-backup",
          "name": "Molnsynkronisering",
          "sector": "general",
          "category": "operations",
          "icon": "Cloud",
          "dataPattern": "manual",
          "description": "Synka säkerhetsbackup till din egen molnlagring",
          "longDescription": "Koppla ditt Google Drive- eller Dropbox-konto och ladda upp en fullständig säkerhetsbackup med ett klick. Accounted skapar en ZIP med SIE-filer, kvitton och behandlingshistorik och laddar upp till en egen mapp i din molnlagring. Du kan koppla båda samtidigt, med separata scheman. Perfekt för att uppfylla egna krav på redundans.",
          "hasOwnData": true,
          "subscriptionNotice": "Kräver ett Google- eller Dropbox-konto. Uppladdningar sker direkt till din egen molnlagring: ingen data lagras hos tredje part utöver den tjänst du väljer."
    },
    {
          "slug": "skatteverket",
          "name": "Skatteverket Integration",
          "sector": "general",
          "category": "operations",
          "icon": "FileCheck",
          "dataPattern": "core",
          "description": "Skicka momsdeklaration direkt till Skatteverket via BankID.",
          "longDescription": "Anslut till Skatteverket med BankID och skicka din momsdeklaration direkt från gnubok. Spara utkast, validera, lås och signera: utan att lämna appen."
    },
    {
          "slug": "invoice-inbox",
          "name": "Dokumentinkorg",
          "sector": "general",
          "category": "import",
          "icon": "Inbox",
          "dataPattern": "both",
          "description": "Vidarebefordra leverantörsfakturor till en unik adress: dokumenten landar här med extraherade fält",
          "longDescription": "Varje bolag får en unik fakturainkorg-adress. Fakturor som skickas dit fångas automatiskt och fält som org.nr, OCR, bankgiro, belopp och förfallodatum läses av med AI. Kräver AI-funktionen i din prenumeration.",
          "readsCoreTables": [
                "document_attachments",
                "suppliers"
          ],
          "hasOwnData": true
    },
    {
          "slug": "document-extraction",
          "name": "AI-extrahering av underlag",
          "sector": "general",
          "category": "accounting",
          "icon": "MessageCircle",
          "dataPattern": "both",
          "description": "Läser kvitton och fakturor med AI och fyller i leverantör, belopp, moms och datum automatiskt",
          "longDescription": "Lyssnar på document.uploaded-händelser och kör Claude på varje uppladdat kvitto eller faktura (PDF eller bild), via AWS Bedrock eller Anthropics API beroende på vilka nycklar som är satta. De extraherade fälten skrivs till document_attachments.extracted_data så att den specialiserade bokföringsassistenten kan föreslå rätt BAS-konto utan att fråga användaren om sådant som redan står på underlaget. Hoppar över dokument som redan extraherats av andra extensions (t.ex. invoice-inbox) för att undvika dubbla AI-anrop.",
          "readsCoreTables": [
                "document_attachments",
                "invoice_inbox_items"
          ]
    },
    {
          "slug": "stripe",
          "name": "Stripe-betalningar",
          "sector": "general",
          "category": "operations",
          "icon": "CreditCard",
          "dataPattern": "manual",
          "description": "Betalningslänkar på fakturor och automatisk avprickning via Stripe",
          "longDescription": "Koppla företagets Stripe-konto så skapas en betalningslänk automatiskt när du skickar en faktura. Betalningar prickas av mot rätt faktura och Stripe-utbetalningar bokförs med avgifter och moms.",
          "hasOwnData": true,
          "subscriptionNotice": "Denna integration kräver ett eget Stripe-konto. Stripes transaktionsavgifter tillkommer enligt ditt avtal med Stripe."
    },
    {
          "slug": "whatsapp-inbox",
          "name": "WhatsApp-inkorg",
          "sector": "general",
          "category": "import",
          "icon": "MessageCircle",
          "dataPattern": "both",
          "description": "Skicka kvitton som foto eller PDF till Accounteds WhatsApp-nummer: de landar i Underlag med avlästa fält",
          "longDescription": "Koppla ditt mobilnummer med en engångskod och skicka sedan kvitton direkt i WhatsApp. Varje kvitto laddas upp till dokumentarkivet, fält som belopp och datum läses av med AI, och du får en bekräftelse i chatten. Bokföringen sker som vanligt i appen.",
          "readsCoreTables": [
                "company_members",
                "document_attachments",
                "invoice_inbox_items"
          ],
          "hasOwnData": true
    },
    {
          "slug": "woocommerce",
          "name": "WooCommerce",
          "sector": "general",
          "category": "import",
          "icon": "ShoppingCart",
          "dataPattern": "manual",
          "description": "Hämta betalda ordrar och återbetalningar från din WooCommerce-butik till transaktionsinkorgen",
          "longDescription": "Anslut din WooCommerce-butik så hämtas betalda ordrar och återbetalningar automatiskt varje natt till transaktionsinkorgen, som ett bankflöde för butiken. Inget bokförs automatiskt: du bokför raderna själv precis som vanliga banktransaktioner.",
          "hasOwnData": true
    },
    {
          "slug": "shopify",
          "name": "Shopify",
          "sector": "general",
          "category": "import",
          "icon": "ShoppingBag",
          "dataPattern": "manual",
          "description": "Hämta betalda ordrar och återbetalningar från din Shopify-butik till Ordersidan",
          "longDescription": "Anslut din Shopify-butik så hämtas betalda ordrar och återbetalningar automatiskt varje natt till Ordersidan, med belopp, betalsätt och moms per sats. Inget bokförs automatiskt: du bokför varje order själv från Ordersidan.",
          "hasOwnData": true
    },
    {
          "slug": "mail",
          "name": "Brevlådor",
          "sector": "general",
          "category": "operations",
          "icon": "Mail",
          "dataPattern": "manual",
          "description": "Låt Kvittojakten leta upp kvitton i era brevlådor",
          "longDescription": "Koppla en eller flera brevlådor, så letar Kvittojakten själv upp kvitton till kortköp som saknar underlag. Åtkomsten är läsbehörighet: agenten kan aldrig skicka, ändra eller radera något i din mejl. Inkorgen kopieras aldrig, utan bara mejl som kan vara ett kvitto till ett visst köp hämtas i stunden och släpps igen. Det som blir underlag arkiveras i ert vanliga sjuåriga arkiv, efter att du godkänt det.",
          "hasOwnData": true,
          "subscriptionNotice": "Kräver ett Google-konto. Varje brevlåda kopplas av sin egen ägare och kan kopplas från när som helst."
    },
  ],
}
