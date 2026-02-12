import { type Page } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getAHContext } from "./ah-login";
import { screenshot, log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

interface Bonus {
  productName: string;
  discountLabel: string;
  originalPrice: number | null;
  bonusPrice: number | null;
  category: string;
  validFrom: string | null;
  validUntil: string | null;
  scrapedAt: string;
}

async function scrapeBonuses(page: Page): Promise<Bonus[]> {
  log("AH-Bonus", "Navigeren naar bonus pagina...");
  await page.goto("https://www.ah.be/bonus", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForTimeout(3_000);

  // Dump HTML voor analyse
  const html = await page.content();
  await writeFile(join(DATA_DIR, "ah-bonus-page.html"), html);
  await screenshot(page, "ah-bonus-01-page");
  log("AH-Bonus", "HTML opgeslagen in data/ah-bonus-page.html");

  // Scroll om alle items te laden
  log("AH-Bonus", "Alle bonusproducten laden...");
  let previousHeight = 0;
  let stableRounds = 0;
  while (stableRounds < 3) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_500);
  }
  await screenshot(page, "ah-bonus-02-all-loaded");

  // Scrape bonus items
  const bonuses = await page.evaluate(() => {
    const items: {
      productName: string;
      discountLabel: string;
      originalPrice: number | null;
      bonusPrice: number | null;
    }[] = [];

    // Zoek promotion kaarten via data-testhook
    const cards = document.querySelectorAll('[data-testhook="promotion-card"]');

    cards.forEach((card) => {
      // Titel
      const titleEl = card.querySelector('[data-testhook="promotion-card-title"]');
      const productName = titleEl?.textContent?.trim() || "";
      if (!productName) return;

      // Discount label uit aria-label van het label element
      const labelEl = card.querySelector('[data-testhook="promotion-labels"] [aria-label]');
      const discountLabel = labelEl?.getAttribute("aria-label") || "";

      // Prijs: promotion-price bevat [euros+".", centen, originele_prijs]
      let originalPrice: number | null = null;
      let bonusPrice: number | null = null;

      const priceEl = card.querySelector('[class*="promotion-price"]');
      if (priceEl) {
        // Verzamel alle directe tekst-nodes in price spans/p's
        const priceParts: string[] = [];
        priceEl.querySelectorAll("p, span").forEach((el) => {
          const text = el.textContent?.trim();
          if (text) priceParts.push(text);
        });

        // Structuur: ["4.", "12", "5.49"] → bonus=4.12, orig=5.49
        if (priceParts.length >= 3) {
          const euros = priceParts[0]!.replace(".", "");
          const cents = priceParts[1]!;
          bonusPrice = parseFloat(`${euros}.${cents}`);
          originalPrice = parseFloat(priceParts[2]!);
        }
      }

      items.push({ productName, discountLabel, originalPrice, bonusPrice });
    });

    return items;
  });

  const now = new Date().toISOString();

  return bonuses.map((b) => ({
    ...b,
    category: "",
    validFrom: null,
    validUntil: null,
    scrapedAt: now,
  }));
}

if (import.meta.main) {
  log("AH-Bonus", "=== AH.be Bonus Aanbiedingen Scraper ===");

  const { context, page } = await getAHContext();

  try {
    const bonuses = await scrapeBonuses(page);

    if (bonuses.length === 0) {
      log("AH-Bonus", "Geen bonussen gevonden. Check data/ah-bonus-page.html en screenshots.");
    } else {
      await writeFile(join(DATA_DIR, "ah-bonuses.json"), JSON.stringify(bonuses, null, 2));
      log("AH-Bonus", `\n=== Klaar! ${bonuses.length} bonussen opgeslagen ===`);

      bonuses.slice(0, 5).forEach((b) => {
        log("AH-Bonus", `  - ${b.productName}: ${b.discountLabel}`);
      });
    }
  } finally {
    await context.close();
  }
}

export { scrapeBonuses };
export type { Bonus };
