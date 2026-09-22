import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
export const metadata: Metadata = {
  title: "Unified LP Scanner",
  description: "Read-only concentrated liquidity activity and risk monitor",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="brand-icon">∿</span>
            <span>
              UNIFIED <b>LP SCANNER</b>
            </span>
          </Link>
          <div className="readonly">
            <span className="dot" />
            READ-ONLY <span className="hide-small">/ NO WALLET REQUIRED</span>
          </div>
        </header>
        <main>{children}</main>
        <footer>
          <span>OBSERVE ACTIVITY. UNDERSTAND RISK.</span>
          <span>
            Public data from Meteora &amp;{" "}
            <a href="https://www.geckoterminal.com" target="_blank" rel="noreferrer">
              GeckoTerminal
            </a>
            . No expected-return claims.
          </span>
        </footer>
      </body>
    </html>
  );
}
