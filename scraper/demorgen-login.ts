import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "path";
import { existsSync } from "fs";
import { screenshot, log } from "./utils";

const AUTH_STATE_DIR = join(import.meta.dir, "..", "auth-state");
const DM_AUTH_FILE = join(AUTH_STATE_DIR, "demorgen.json");

const DM_EMAIL = process.env.DEMORGEN_EMAIL;
const DM_PASSWORD = process.env.DEMORGEN_PASSWORD;

if (!DM_EMAIL || !DM_PASSWORD) {
  console.error("Stel DEMORGEN_EMAIL en DEMORGEN_PASSWORD in via .env bestand");
  process.exit(1);
}

export async function loginDeMorgen(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  log("DeMorgen", "Navigeren naar koken.demorgen...");

  await page.goto("https://koken.demorgen.be");
  await page.waitForLoadState("networkidle");
  await screenshot(page, "dm-01-homepage");

  // Cookie consent
  try {
    const cookieButton = page.locator('button:has-text("Akkoord"), button:has-text("Accepteren"), button:has-text("Accept"), [id*="accept"]');
    await cookieButton.first().click({ timeout: 5_000 });
    log("DeMorgen", "Cookie consent afgehandeld");
    await screenshot(page, "dm-02-after-cookies");
  } catch {
    log("DeMorgen", "Geen cookie popup gevonden");
  }

  // Zoek de inlog-knop
  log("DeMorgen", "Inlogknop zoeken...");
  try {
    const loginLink = page.locator('a:has-text("Inloggen"), a:has-text("Log in"), button:has-text("Inloggen"), [class*="login"]');
    await loginLink.first().click({ timeout: 5_000 });
    await page.waitForLoadState("networkidle");
    await screenshot(page, "dm-03-login-page");
  } catch {
    log("DeMorgen", "Geen aparte login knop gevonden, probeer directe URL...");
    await page.goto("https://koken.demorgen.be/login");
    await page.waitForLoadState("networkidle");
    await screenshot(page, "dm-03-login-direct");
  }

  // Email invullen
  log("DeMorgen", "Email invullen...");
  const emailInput = page.locator('input[type="email"], input[name="email"], input[id*="email"], input[placeholder*="mail"]');
  await emailInput.first().fill(DM_EMAIL!);
  await screenshot(page, "dm-04-email-filled");

  // Password invullen
  log("DeMorgen", "Wachtwoord invullen...");
  const passwordInput = page.locator('input[type="password"], input[name="password"]');
  await passwordInput.first().fill(DM_PASSWORD!);
  await screenshot(page, "dm-05-password-filled");

  // Inloggen
  log("DeMorgen", "Inloggen...");
  const loginButton = page.locator('button[type="submit"], button:has-text("Inloggen"), button:has-text("Log in")');
  await loginButton.first().click();

  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3_000);
  await screenshot(page, "dm-06-after-login");

  log("DeMorgen", `Huidige URL na login: ${page.url()}`);

  // Sla sessie op
  await context.storageState({ path: DM_AUTH_FILE });
  log("DeMorgen", `Auth state opgeslagen in ${DM_AUTH_FILE}`);

  return page;
}

export async function getAuthenticatedDeMorgenContext() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
  });

  if (existsSync(DM_AUTH_FILE)) {
    log("DeMorgen", "Bestaande sessie gevonden, hergebruiken...");
    const context = await browser.newContext({ storageState: DM_AUTH_FILE });
    const page = await context.newPage();

    await page.goto("https://koken.demorgen.be");
    await page.waitForLoadState("networkidle");

    // Check of we nog ingelogd zijn
    const isLoggedIn = await page.evaluate(() => {
      // Zoek naar indicatoren dat we ingelogd zijn
      const loginButton = document.querySelector('a:has-text("Inloggen"), button:has-text("Inloggen")');
      return !loginButton;
    });

    if (isLoggedIn) {
      log("DeMorgen", "Sessie is nog geldig!");
      return { browser, context, page };
    }

    log("DeMorgen", "Sessie verlopen, opnieuw inloggen...");
    await page.close();
    await context.close();
  }

  const context = await browser.newContext();
  const page = await loginDeMorgen(context);
  return { browser, context, page };
}

if (import.meta.main) {
  log("DeMorgen", "=== koken.demorgen Login Verkenning ===");

  const { browser, page } = await getAuthenticatedDeMorgenContext();

  log("DeMorgen", "Ingelogd! Navigeren naar favorieten...");

  // Probeer favorieten te vinden
  const possibleUrls = [
    "https://koken.demorgen.be/favorieten",
    "https://koken.demorgen.be/mijn-recepten",
    "https://koken.demorgen.be/profiel/favorieten",
    "https://koken.demorgen.be/account/favorieten",
  ];

  for (const url of possibleUrls) {
    log("DeMorgen", `Probeer: ${url}`);
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const status = page.url();
    log("DeMorgen", `  → Redirect naar: ${status}`);
    if (!status.includes("404") && !status.includes("error")) {
      await screenshot(page, `dm-07-favorieten-${url.split("/").pop()}`);
    }
  }

  log("DeMorgen", "");
  log("DeMorgen", "Browser is open. Verken de structuur handmatig.");
  log("DeMorgen", "Druk Ctrl+C in de terminal om af te sluiten.");

  await new Promise(() => {});
}
