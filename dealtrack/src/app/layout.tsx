import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Light or dark before anything is drawn (no white flash): the choice from the switch in the top bar,
// or else the computer's setting. Printing is always light.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("dealtrack-theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;var e=document.documentElement;e.classList.toggle("dark",d);e.style.colorScheme=d?"dark":"light";var was;addEventListener("beforeprint",function(){was=e.classList.contains("dark");e.classList.remove("dark")});addEventListener("afterprint",function(){if(was)e.classList.add("dark")})}catch(_){}})()`

export const metadata: Metadata = {
  title: "DealTrack · Twin Home Buyer",
  description: "Google Ads results for Twin Home Buyer: spend, leads, wasted search terms, and cities.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The theme script below sets the dark class before the page shows.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
