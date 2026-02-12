import { chromium } from "playwright";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { screenshot, log } from "./utils";

const PROFILE_DIR = join(import.meta.dir, "..", "browser-profile-demorgen");
const DATA_DIR = join(import.meta.dir, "..", "data");

await mkdir(DATA_DIR, { recursive: true });

const FAVORIETEN_URL = "https://koken.demorgen.be/mijn-favoriete-recepten/";

// Persistent context = echt browserprofiel, sessie blijft bewaard
export async function getDeMorgenContext() {
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

if (import.meta.main) {
  log("DeMorgen", "=== koken.demorgen Interactieve Verkenning ===");
  log("DeMorgen", "");

  const { context, page } = await getDeMorgenContext();

  // Navigeer naar favorieten (redirect naar login als niet ingelogd)
  await page.goto(FAVORIETEN_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForTimeout(3_000);

  // Check of we al ingelogd zijn
  const currentUrl = page.url();
  if (currentUrl.includes("koken.demorgen.be/mijn-favoriete-recepten")) {
    log("DeMorgen", "Je bent al ingelogd! Sessie is nog geldig.");
  } else {
    log("DeMorgen", "========================================");
    log("DeMorgen", "Browser is open.");
    log("DeMorgen", "");
    log("DeMorgen", "Stappen:");
    log("DeMorgen", "1. Log handmatig in op koken.demorgen.be");
    log("DeMorgen", "2. Navigeer naar je favorieten");
    log("DeMorgen", "3. Zodra je op de favorieten pagina bent,");
    log("DeMorgen", "   typ 'ready' in de terminal en druk Enter");
    log("DeMorgen", "========================================");
    log("DeMorgen", "");

    const reader = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise<void>((resolve) => {
      const checkReady = () => {
        reader.question("[DeMorgen] Typ 'ready' als je op de favorieten pagina bent: ", (answer: string) => {
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
  }

  log("DeMorgen", `Huidige URL: ${page.url()}`);
  await screenshot(page, "dm-favorieten-page");

  // Dump de HTML
  const html = await page.content();
  await writeFile(join(DATA_DIR, "dm-favorieten-page.html"), html);
  log("DeMorgen", "Favorieten HTML opgeslagen in data/dm-favorieten-page.html");

  // Zoek recept-links
  const recipeLinks = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a.card-recept-link[href*="/recepten/"]');
    return [...new Set(Array.from(anchors).map((a) => (a as HTMLAnchorElement).href))];
  });

  log("DeMorgen", `${recipeLinks.length} recept-links gevonden op de pagina`);
  recipeLinks.slice(0, 10).forEach((l) => {
    log("DeMorgen", `  → ${l}`);
  });

  log("DeMorgen", "");
  log("DeMorgen", "Browser blijft open. Verken verder of druk Ctrl+C om af te sluiten.");
  log("DeMorgen", "(Browserprofiel is opgeslagen - volgende keer ben je nog ingelogd)");

  await new Promise(() => {});
}
