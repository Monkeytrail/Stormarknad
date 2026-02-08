import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "path";
import { existsSync } from "fs";
import { screenshot, log } from "./utils";

const AUTH_STATE_DIR = join(import.meta.dir, "..", "auth-state");
const AH_AUTH_FILE = join(AUTH_STATE_DIR, "ah.json");

const AH_EMAIL = process.env.AH_EMAIL;
const AH_PASSWORD = process.env.AH_PASSWORD;

if (!AH_EMAIL || !AH_PASSWORD) {
  console.error("Stel AH_EMAIL en AH_PASSWORD in via .env bestand");
  process.exit(1);
}

export async function createBrowser() {
  return chromium.launch({
    headless: false,
    slowMo: 100,
  });
}

export async function loginAH(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  log("AH", "Navigeren naar AH.be...");

  await page.goto("https://www.ah.be/mijn/inloggen");
  await screenshot(page, "ah-01-login-page");

  // Cookie consent afhandelen (als die verschijnt)
  try {
    const cookieButton = page.locator('[id*="accept"], [data-testid*="cookie"] button, #decline-cookies, button:has-text("Accepteren"), button:has-text("Alles accepteren")');
    await cookieButton.first().click({ timeout: 5_000 });
    log("AH", "Cookie consent afgehandeld");
    await screenshot(page, "ah-02-after-cookies");
  } catch {
    log("AH", "Geen cookie popup gevonden, doorgaan...");
  }

  // Wacht even zodat de pagina volledig geladen is
  await page.waitForLoadState("networkidle");
  await screenshot(page, "ah-03-ready-to-login");

  // Email invullen
  log("AH", "Email invullen...");
  const emailInput = page.locator('input[type="email"], input[name="email"], input[id*="email"], input[autocomplete="email"]');
  await emailInput.first().fill(AH_EMAIL!);
  await screenshot(page, "ah-04-email-filled");

  // Password invullen
  log("AH", "Wachtwoord invullen...");
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[id*="password"]');
  await passwordInput.first().fill(AH_PASSWORD!);
  await screenshot(page, "ah-05-password-filled");

  // Inloggen klikken
  log("AH", "Inloggen...");
  const loginButton = page.locator('button[type="submit"], button:has-text("Inloggen"), button:has-text("Log in")');
  await loginButton.first().click();

  // Wacht op navigatie na login
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3_000);
  await screenshot(page, "ah-06-after-login");

  // Controleer of we ingelogd zijn
  const url = page.url();
  log("AH", `Huidige URL na login: ${url}`);

  // Sla de sessie op voor hergebruik
  const state = await context.storageState({ path: AH_AUTH_FILE });
  log("AH", `Auth state opgeslagen in ${AH_AUTH_FILE}`);

  return page;
}

// Hergebruik bestaande sessie als die er is
export async function getAuthenticatedContext() {
  const browser = await createBrowser();

  if (existsSync(AH_AUTH_FILE)) {
    log("AH", "Bestaande sessie gevonden, hergebruiken...");
    const context = await browser.newContext({ storageState: AH_AUTH_FILE });
    const page = await context.newPage();

    // Test of sessie nog geldig is
    await page.goto("https://www.ah.be/mijn");
    await page.waitForLoadState("networkidle");

    const url = page.url();
    if (!url.includes("inloggen")) {
      log("AH", "Sessie is nog geldig!");
      return { browser, context, page };
    }

    log("AH", "Sessie verlopen, opnieuw inloggen...");
    await page.close();
    await context.close();
  }

  const context = await browser.newContext();
  const page = await loginAH(context);
  return { browser, context, page };
}

// Als dit script direct gedraaid wordt: login en laat browser open
if (import.meta.main) {
  log("AH", "=== AH.be Login Verkenning ===");

  const { browser, page } = await getAuthenticatedContext();

  log("AH", "Ingelogd! Browser blijft open voor verkenning.");
  log("AH", "Navigeer naar favorieten/recepten pagina...");

  // Probeer naar de Allerhande favorieten te navigeren
  await page.goto("https://www.ah.be/allerhande/favorieten");
  await page.waitForLoadState("networkidle");
  await screenshot(page, "ah-07-favorieten-page");
  log("AH", `Favorieten URL: ${page.url()}`);

  // Laat de browser open zodat de gebruiker kan verkennen
  log("AH", "");
  log("AH", "Browser is open. Verken de structuur handmatig.");
  log("AH", "Druk Ctrl+C in de terminal om af te sluiten.");

  // Houd het script draaiende
  await new Promise(() => {});
}
