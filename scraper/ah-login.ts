import { chromium, type Page } from "playwright";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { screenshot, log } from "./utils";

const PROFILE_DIR = join(import.meta.dir, "..", "browser-profile-ah");
const DATA_DIR = join(import.meta.dir, "..", "data");

await mkdir(DATA_DIR, { recursive: true });

// Persistent context = echt browserprofiel, sessie blijft bewaard
export async function getAHContext() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 50,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 720 },
    locale: "nl-BE",
    timezoneId: "Europe/Brussels",
  });

  const page = context.pages()[0] || (await context.newPage());

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return { context, page };
}

// Check of gebruiker is ingelogd op een pagina
export async function isLoggedIn(page: Page): Promise<boolean> {
  // Zoek naar typische ingelogde indicatoren op AH.be
  return page.evaluate(() => {
    const url = window.location.href;
    // Als we op de inlogpagina zijn, zijn we niet ingelogd
    if (url.includes("inloggen")) return false;
    // Zoek naar account/profiel elementen
    const accountEl = document.querySelector('[class*="account"], [class*="profile"], [class*="user"]');
    return !!accountEl;
  });
}

if (import.meta.main) {
  log("AH", "=== AH.be Interactieve Verkenning ===");
  log("AH", "");

  const { context, page } = await getAHContext();

  // Navigeer naar AH.be
  await page.goto("https://www.ah.be", { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForTimeout(2_000);

  log("AH", "========================================");
  log("AH", "Browser is open op ah.be.");
  log("AH", "");
  log("AH", "Stappen:");
  log("AH", "1. Log handmatig in op ah.be");
  log("AH", "2. Navigeer naar je Allerhande favorieten");
  log("AH", "3. Zodra je op de favorieten pagina bent,");
  log("AH", "   typ 'ready' in de terminal en druk Enter");
  log("AH", "========================================");
  log("AH", "");

  // Wacht tot gebruiker 'ready' typt
  const reader = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve) => {
    const checkReady = () => {
      reader.question("[AH] Typ 'ready' als je op de favorieten pagina bent: ", (answer: string) => {
        if (answer.trim().toLowerCase() === "ready") {
          reader.close();
          resolve();
        } else {
          checkReady();
        }
      });
    };
    checkReady();
  });

  // Gebruiker is op de favorieten pagina
  const currentUrl = page.url();
  log("AH", `Huidige URL: ${currentUrl}`);
  await screenshot(page, "ah-favorieten-page");

  // Dump de HTML
  const html = await page.content();
  await writeFile(join(DATA_DIR, "ah-favorieten-page.html"), html);
  log("AH", "HTML opgeslagen in data/ah-favorieten-page.html");

  // Zoek recept-links
  const recipeLinks = await page.evaluate(() => {
    const links: { text: string; href: string }[] = [];
    document.querySelectorAll("a").forEach((a) => {
      const href = a.href || "";
      if (href.includes("/allerhande/recept/") || href.includes("/recept/")) {
        links.push({
          text: a.textContent?.trim() || "",
          href,
        });
      }
    });
    return [...new Map(links.map((l) => [l.href, l])).values()];
  });

  log("AH", `${recipeLinks.length} recept-links gevonden op de pagina`);
  recipeLinks.slice(0, 10).forEach((l) => {
    log("AH", `  "${l.text}" → ${l.href}`);
  });

  // Sla de links op
  await writeFile(join(DATA_DIR, "ah-recipe-links.json"), JSON.stringify(recipeLinks, null, 2));
  log("AH", `Alle links opgeslagen in data/ah-recipe-links.json`);

  log("AH", "");
  log("AH", "Browser blijft open. Verken verder of druk Ctrl+C om af te sluiten.");
  log("AH", "(Browserprofiel is opgeslagen - volgende keer ben je nog ingelogd)");

  await new Promise(() => {});
}
