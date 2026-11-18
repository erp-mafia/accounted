import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { Hedvig_Letters_Serif } from "next/font/google";
import {
  Fraunces,
  Lora,
  Playfair_Display,
  Public_Sans,
  Source_Sans_3,
  Work_Sans,
} from "next/font/google";
import { headers } from "next/headers";
import Script from "next/script";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip-provider";
import { DeployReloadPrompt } from "@/components/system/DeployReloadPrompt";
import { ThemeColorSync } from "@/components/system/ThemeColorSync";
import { ThemeProvider } from "@/components/theme-provider";
import { PaletteProvider } from "@/components/providers/PaletteProvider";
import { NonceProvider } from "@/components/providers/NonceProvider";
import { SWRProvider } from "@/components/providers/SWRProvider";
import { ScrollbarReveal } from "@/components/ScrollbarReveal";
import { isSelfHosted } from "@/lib/env/public-flags";
import { getBranding } from "@/lib/branding/service";
import { resolveRequestBrand } from "@/lib/branding/request-brand";
import { getBrandFontPair } from "@/lib/branding/fonts";
import { BrandProvider } from "@/lib/branding/brand-context";
import { toPublicBrand } from "@/lib/branding/public-brand";
import { APP_TIME_ZONE } from "@/i18n/config";
import { ROOT_CLIENT_NAMESPACES, pickNamespaces } from "@/i18n/root-client-namespaces";
import { CSP_NONCE_HEADER } from "@/lib/security/csp";
// A fork's branding extension calls registerBrandingService() at module load,
// so it must run before metadata, viewport or the layout read getBranding();
// server-render errors logged through createLogger() reach PostHog Error
// Tracking (gated on the token). lib/server-baseline does both without
// loading an extension; extensions load from instrumentation.ts at boot
// (lib/initialized.ts), never in a page's own graph.
import "@/lib/server-baseline";
import "./globals.css";
import RootErrorBoundary from "./error";

// The root error boundary (./error.tsx) is loaded with every page, but as a
// sibling of the pages rather than their parent: what it imports (the
// standalone page frame, the brand mark and its next/image, the support
// dialog) was bundled once for the boundary and again for the dashboard
// shell, the sign-in pages and the not-found page. Naming it here puts those
// modules in this layout's chunk group, which every segment below reuses, so
// each ships once (scripts/perf/README.md, "Page budgets").
void RootErrorBoundary;

// Brand resolution (WL-12: the lookup runs in the root layout, not
// middleware) lives in lib/branding/request-brand.ts, shared with every
// other server component so the BRAND_DEV_DOMAIN dev override applies
// uniformly. The layout used to carry a private copy of the function, which
// silently skipped that override.

// Stil v3 (product decision 2026-10-29): Inter is the one face for text,
// Geist Mono stays for account numbers and code, Hedvig for headline numbers.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const hedvigSerif = Hedvig_Letters_Serif({
  variable: "--font-hedvig-serif",
  subsets: ["latin"],
  display: "swap",
  // Hedvig Letters Serif on Google Fonts only ships 400; the brand wordmark
  // requests 700, which browsers synthesize from this file. Keep the load
  // single-file to stay within the existing display-font budget.
  weight: "400",
});

// Curated brand font menu (WL-03/WL-12): every menu font registers here so
// its @font-face and CSS variable exist on every host, but with
// `preload: false`: only the default pair above preloads, and a browser only
// downloads a menu font when a branded host actually resolves its var()
// (lib/branding/fonts.ts picks the pair per request). All Google Fonts, OFL.
const loraSerif = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const frauncesSerif = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const workSans = Work_Sans({
  variable: "--font-work-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const playfairSerif = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
  preload: false,
});

// The brand font menu's variable classes, appended to <html> so every menu
// pair's var() is resolvable whichever brand serves the request.
const brandFontVariables = [
  loraSerif.variable,
  sourceSans.variable,
  frauncesSerif.variable,
  workSans.variable,
  playfairSerif.variable,
  publicSans.variable,
].join(" ");

export async function generateMetadata(): Promise<Metadata> {
  const b = getBranding();
  const brand = await resolveRequestBrand();
  const appName = brand?.appName ?? b.appName;
  return {
    title: appName,
    description: b.appDescription,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: appName,
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  return {
    themeColor: getBranding().themeColor,
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const branding = getBranding();
  const brand = await resolveRequestBrand();
  const locale = await getLocale();
  // Client components under this provider get only the public and auth
  // namespaces: every page inlines them into its HTML, and the full catalog
  // is about 0.8 MB per locale. The dashboard, onboarding and other app
  // layouts restore the full set with AllMessagesProvider.
  const messages = pickNamespaces(await getMessages(), ROOT_CLIENT_NAMESPACES);
  // Per-request CSP nonce from the proxy (src/proxy.ts, lib/security/csp.ts).
  // Next.js stamps it on its own scripts; the scripts this layout renders
  // (next-themes' and the palette's no-flash scripts, the service-worker
  // registration, Turnstile via NonceProvider) must carry it themselves or
  // the strict script-src blocks them. Reading the request header keeps
  // every page dynamic, which a nonce requires anyway: resolveRequestBrand
  // already reads headers() above.
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  // Brand COLOR theming deliberately removed (product call 2026-08-04):
  // white-label is logo + app name + domain only; every host renders the
  // standard editorial-monochrome theme. buildBrandVarsCss and the
  // brands.brand_color/chrome_color columns stay dormant for a future
  // opt-in, but nothing stamps data-brand anymore.

  // Curated font menu (WL-03): inline style on <html> beats the :root
  // declarations in globals.css. Null (default pair or unknown key) means no
  // style attribute at all, keeping default hosts byte-identical.
  const fontPair = brand ? getBrandFontPair(brand.fontKey) : null;

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable} ${geistMono.variable} ${hedvigSerif.variable} ${brandFontVariables}`}
      style={
        fontPair
          ? ({
              "--font-display": fontPair.display,
              "--font-body": fontPair.body,
            } as React.CSSProperties)
          : undefined
      }
    >
      <head>
        <link rel="apple-touch-icon" href={branding.appleTouchIconPath} />
        {/* Tab icon: the brand's dedicated square favicon when set, else the
            logo (a wide lockup squeezed to 16px, but better than the default
            on a branded host), else the default mark. Always exactly one
            rel="icon" tag: app/icon.png (Next's file-convention favicon) was
            removed because it injected its own unconditional tag that beat
            this one in the browser, so branded hosts never saw their icon. */}
        <link rel="icon" href={brand?.faviconUrl ?? brand?.logoUrl ?? branding.logoPath} />
      </head>
      <body
        className="antialiased"
      >
        <NonceProvider nonce={nonce}>
          {/* timeZone is passed explicitly: client components must format in the
              same zone the server rendered with, or timestamps shift on hydration. */}
          <NextIntlClientProvider locale={locale} messages={messages} timeZone={APP_TIME_ZONE}>
            <BrandProvider brand={brand ? toPublicBrand(brand) : null}>
              <ThemeProvider
                attribute="class"
                defaultTheme="light"
                enableSystem
                disableTransitionOnChange
                nonce={nonce}
              >
                <PaletteProvider nonce={nonce}>
                  <SWRProvider>
                    <TooltipProvider>
                      {children}
                      <Toaster />
                      <DeployReloadPrompt />
                      <ThemeColorSync />
                      <ScrollbarReveal />
                    </TooltipProvider>
                  </SWRProvider>
                </PaletteProvider>
              </ThemeProvider>
            </BrandProvider>
          </NextIntlClientProvider>
        </NonceProvider>
        {/* Vercel Speed Insights is hosted-only telemetry: a self-hosted
            (AGPL) instance must not report its users' page timings to our
            Vercel project. Read through lib/env/public-flags, never compared
            in place (the Docker build folds in-place NEXT_PUBLIC_* reads). */}
        {!isSelfHosted() && <SpeedInsights />}
        <Script src="/sw-register.js" strategy="afterInteractive" nonce={nonce} />
      </body>
    </html>
  );
}
