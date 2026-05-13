import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Hedvig_Letters_Serif } from "next/font/google";
import Script from "next/script";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { ensureInitialized } from "@/lib/init";
import { getBranding } from "@/lib/branding/service";
import "./globals.css";

// Load extensions before metadata/viewport functions read the branding service.
// Without this, an extension that calls registerBrandingService() at its module
// load time would not have run yet when the first request hits this layout.
ensureInitialized();

const geistSans = Geist({
  variable: "--font-geist-sans",
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
  weight: "400",
});

export function generateMetadata(): Metadata {
  const b = getBranding();
  return {
    title: b.appName,
    description: b.appDescription,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: b.appName,
    },
  };
}

export function generateViewport(): Viewport {
  return {
    themeColor: getBranding().themeColor,
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const branding = getBranding();
  return (
    <html lang="sv" translate="no" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${hedvigSerif.variable}`}>
      <head>
        <meta name="google" content="notranslate" />
        <link rel="apple-touch-icon" href={branding.appleTouchIconPath} />
        <script
          src="https://cdn.recapt.app/browser/glimt.js"
          async
          data-public-key="pk_8de220ce34c81413de154d10ff681a9eb3a5a9c12d28bd6c7bc2613c9f5acfbb"
          data-persist
          data-enable-user-comments
        />
      </head>
      <body
        className="antialiased"
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
        <Script src="/sw-register.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
