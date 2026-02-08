import { chromium, type Page } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { screenshot, log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

interface Bonus {
  productName: string;
  discountLabel: string;
  originalPrice: number | null;
  bonusPrice: number | null;
  category: string;
  validFrom: string;
  validUntil: string;
  scrapedAt: string;
}

async function scrapeBonuses(page: Page): Promise<Bonus[]> {
  log("AH-Bonus", "Navigeren naar bonus pagina...");
  await page.goto("https://www.ah.be/bonus");
  await page.waitForLoadState("networkidle");

  // Cookie consent afhandelen
  try {
    const cookieButton = page.locator('button:has-text("Accepteren"), button:has-text("Alles accepteren")');
    await cookieButton.first().click({ timeout: 3_000 });
    log("AH-Bonus", "Cookie consent afgehandeld");
  } catch {
    // Geen cookie popup
  }

  await page.waitForLoadState("networkidle");
  await screenshot(page, "ah-bonus-01-page");

  // Scroll om alle items te laden
  log("AH-Bonus", "Alle bonusproducten laden...");
  let previousHeight = 0;
  let attempts = 0;
  while (attempts < 30) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      attempts++;
      if (attempts >= 3) break;
    } else {
      attempts = 0;
    }
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_000);
  }
  await screenshot(page, "ah-bonus-02-all-loaded");

  // Scrape bonus items
  const bonuses = await page.evaluate(() => {
    const items: {
      productName: string;
      discountLabel: string;
      originalPrice: number | null;
      bonusPrice: number | null;
      category: string;
    }[] = [];

    // Zoek bonus product kaarten - probeer meerdere selectors
    const cards = document.querySelectorAll(
      '[class*="bonus"] [class*="card"], [class*="product-card"], [data-testid*="bonus"], [class*="promotion"]'
    );

    cards.forEach((card) => {
      const nameEl = card.querySelector('[class*="title"], h3, h4, [class*="name"]');
      const discountEl = card.querySelector('[class*="discount"], [class*="shield"], [class*="badge"]');
      const priceEls = card.querySelectorAll('[class*="price"]');

      const productName = nameEl?.textContent?.trim() || "";
      const discountLabel = discountEl?.textContent?.trim() || "";

      // Probeer prijzen te parsen
      let originalPrice: number | null = null;
      let bonusPrice: number | null = null;

      priceEls.forEach((el) => {
        const text = el.textContent?.trim() || "";
        const priceMatch = text.match(/([\d,]+)/);
        if (priceMatch) {
          const price = parseFloat(priceMatch[1].replace(",", "."));
          if (el.className.includes("was") || el.className.includes("old") || el.className.includes("original")) {
            originalPrice = price;
          } else {
            bonusPrice = price;
          }
        }
      });

      if (productName) {
        items.push({ productName, discountLabel, originalPrice, bonusPrice, category: "" });
      }
    });

    return items;
  });

  const now = new Date().toISOString();
  // Bonus geldigheid: typisch maandag-zondag
  const today = new Date();
  const dayOfWeek = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return bonuses.map((b) => ({
    ...b,
    validFrom: monday.toISOString().split("T")[0],
    validUntil: sunday.toISOString().split("T")[0],
    scrapedAt: now,
  }));
}

if (import.meta.main) {
  log("AH-Bonus", "=== AH.be Bonus Aanbiedingen Scraper ===");

  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const bonuses = await scrapeBonuses(page);

    if (bonuses.length === 0) {
      log("AH-Bonus", "Geen bonussen gevonden! Check de screenshots.");

      // Dump HTML voor analyse
      const html = await page.content();
      await writeFile(join(DATA_DIR, "ah-bonus-page.html"), html);
      log("AH-Bonus", "HTML opgeslagen in data/ah-bonus-page.html voor analyse");
    } else {
      await writeFile(join(DATA_DIR, "ah-bonuses.json"), JSON.stringify(bonuses, null, 2));
      log("AH-Bonus", `\n=== Klaar! ${bonuses.length} bonussen opgeslagen in data/ah-bonuses.json ===`);

      // Toon een paar voorbeelden
      bonuses.slice(0, 5).forEach((b) => {
        log("AH-Bonus", `  - ${b.productName}: ${b.discountLabel}`);
      });
    }
  } finally {
    await browser.close();
  }
}

export { scrapeBonuses };
export type { Bonus };
