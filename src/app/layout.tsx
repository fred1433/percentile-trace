import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Percentile Trace",
  description:
    "One request, decomposed from the browser to the SQL plan, reported in percentiles.",
  metadataBase: new URL("https://percentile-trace.theaipipe.com"),
  openGraph: {
    title: "Percentile Trace",
    description:
      "One request, decomposed from the browser to the SQL plan, reported in percentiles.",
    url: "https://percentile-trace.theaipipe.com",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
