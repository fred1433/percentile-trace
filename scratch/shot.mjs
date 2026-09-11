import { chromium } from "playwright";
const [,, url, out, doClick] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
await p.goto(url, { waitUntil: "networkidle" });
if (doClick === "click") {
  await p.getByRole("button", { name: /measure it now/i }).click();
  await p.waitForFunction(() => document.body.innerText.includes("measured by this browser"), undefined, { timeout: 40000 });
  await p.waitForTimeout(600);
}
await p.screenshot({ path: out, fullPage: true });
const h = await p.evaluate(() => document.documentElement.scrollHeight);
console.log("page height", h);
await b.close();
