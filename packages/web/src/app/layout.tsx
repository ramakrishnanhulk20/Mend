import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["wdth"],
  variable: "--font-instrument",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mend",
  description:
    "Win back the regulars who went quiet, with PayPal cashback and a random holdout that measures whether it worked.",
};

// A page built ahead of time has no nonce from src/proxy.ts on its scripts, and the policy
// would then block them. Waiting for the request keeps every page rendered per visit.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${instrumentSans.variable} ${plexMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
