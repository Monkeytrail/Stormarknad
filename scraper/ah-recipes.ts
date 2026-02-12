import { type Page } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getAHContext } from "./ah-login";
import { screenshot, log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

interface Ingredient {
  name: string;
  quantity: string;
  unit: string;
  raw: string;
}

interface Recipe {
  title: string;
  url: string;
  imageUrl: string;
  ingredients: Ingredient[];
  instructions: string[];
  servings: number;
  prepTime: number | null;
  calories: number | null;
  tags: string[];
  source: "ah.be";
  scrapedAt: string;
}

const FAVORIETEN_URL = "https://www.ah.be/allerhande/favorieten/categorie/0";

// Haal recept-links van de huidige pagina
async function getRecipeLinksFromPage(page: Page): Promise<string[]> {
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href*="/allerhande/recept/"]');
    const urls = Array.from(anchors).map((a) => (a as HTMLAnchorElement).href);
    return [...new Set(urls)];
  });
  return links;
}

// Haal alle recept-links op door alle pagina's te doorlopen
async function getAllRecipeLinks(page: Page): Promise<string[]> {
  const allLinks = new Set<string>();
  let pageNum = 1;

  while (true) {
    const url = pageNum === 1 ? FAVORIETEN_URL : `${FAVORIETEN_URL}?page=${pageNum}`;
    log("AH-Recipes", `Pagina ${pageNum} laden: ${url}`);

    if (pageNum > 1) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(2_000);
    }

    const links = await getRecipeLinksFromPage(page);
    if (links.length === 0) {
      log("AH-Recipes", `  Geen recepten op pagina ${pageNum}, klaar.`);
      break;
    }

    const before = allLinks.size;
    links.forEach((l) => allLinks.add(l));
    const newCount = allLinks.size - before;
    log("AH-Recipes", `  ${links.length} recepten gevonden (${newCount} nieuw)`);

    // Als er geen nieuwe links zijn, zijn we klaar
    if (newCount === 0) break;

    pageNum++;
  }

  log("AH-Recipes", `Totaal: ${allLinks.size} unieke recept-links over ${pageNum} pagina's`);
  return [...allLinks];
}

// Scrape een individuele recept-pagina
async function scrapeRecipeDetail(page: Page, url: string): Promise<Recipe | null> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(2_000);

    const recipe = await page.evaluate(() => {
      // Titel
      const titleEl = document.querySelector("h1");
      const title = titleEl?.textContent?.trim() || "";

      // Afbeelding - zoek de hoofd-afbeelding
      const imgEl = document.querySelector(
        '[class*="recipe-header"] img, [class*="hero"] img, article img, main img'
      );
      const imageUrl = (imgEl as HTMLImageElement)?.src || "";

      // Ingrediënten - zoek li's met gestructureerde name/unit elementen
      const ingredients: { name: string; quantity: string; unit: string; raw: string }[] = [];
      const seenRaw = new Set<string>();

      const ingredientEls = document.querySelectorAll(
        '[class*="ingredient"] li, [class*="ingredient-list"] li, [data-testid*="ingredient"]'
      );

      ingredientEls.forEach((el) => {
        const nameEl = el.querySelector('[class*="name"], [class*="description"]');
        if (!nameEl) return; // Skip li's zonder name element (parent containers, buttons)

        const name = nameEl.textContent?.trim() || "";
        if (!name || name === "Kies producten") return;

        // Unit element bevat "300 g" of "1 teen" - split in quantity + unit
        const unitText = el.querySelector('[class*="unit"]')?.textContent?.trim() || "";
        const qtyUnitMatch = unitText.match(/^([\d½¼¾⅓⅔,.]+)\s*(.*)$/);
        const quantity = qtyUnitMatch?.[1] || "";
        const unit = qtyUnitMatch?.[2] || "";

        const raw = `${unitText} ${name}`.trim();

        // Deduplicatie
        if (seenRaw.has(raw)) return;
        seenRaw.add(raw);

        ingredients.push({ name, quantity, unit, raw });
      });

      // Bereidingsstappen - deduplicate en filter tips
      const rawSteps: string[] = [];
      const stepEls = document.querySelectorAll(
        '[class*="preparation"] li, [class*="step"] p, [class*="step"] li, [class*="instruction"] li'
      );

      stepEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length > 5) rawSteps.push(text);
      });

      // Deduplicate en clean
      const seenSteps = new Set<string>();
      const instructions: string[] = [];
      for (const step of rawSteps) {
        // Skip tips, achtergrondinfo, algemeen
        if (/^(combinatietip|achtergrondinfo|algemeen)/i.test(step)) continue;

        // Strip leading step number (e.g. "1Kook" → "Kook", "2Halveer" → "Halveer")
        const cleaned = step.replace(/^\d+\s*/, "");
        if (!cleaned || cleaned.length < 5) continue;

        // Deduplicatie op genormaliseerde tekst
        if (seenSteps.has(cleaned)) continue;
        seenSteps.add(cleaned);

        instructions.push(cleaned);
      }

      // Porties - zit in aria-label="Aantal personen: 4"
      let servings = 4;
      const servingsEl = document.querySelector('[aria-label*="Aantal personen"]');
      const servingsMatch = servingsEl?.getAttribute("aria-label")?.match(/(\d+)/);
      if (servingsMatch) servings = parseInt(servingsMatch[1]!);

      // Bereidingstijd
      let prepTime: number | null = null;
      const timeEl = document.querySelector(
        '[class*="time"], [data-testid*="time"], [class*="duration"]'
      );
      const timeMatch = timeEl?.textContent?.match(/(\d+)\s*min/);
      if (timeMatch) prepTime = parseInt(timeMatch[1]!);

      // Calorieën - zit in aria-label="710 kcal"
      let calories: number | null = null;
      const calEl = document.querySelector('[aria-label*="kcal"]');
      const calMatch = calEl?.getAttribute("aria-label")?.match(/(\d+)\s*kcal/);
      if (calMatch) calories = parseInt(calMatch[1]!);

      // Tags
      const tags: string[] = [];
      const seenTags = new Set<string>();
      const tagEls = document.querySelectorAll(
        '[class*="tag"] a, [class*="label"] a, [class*="category"] a, [class*="diet"] span'
      );
      tagEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length < 50 && !seenTags.has(text)) {
          seenTags.add(text);
          tags.push(text);
        }
      });

      return { title, imageUrl, ingredients, instructions, servings, prepTime, calories, tags };
    });

    if (!recipe.title) {
      log("AH-Recipes", `  ⚠️ Geen titel gevonden voor ${url}`);
      return null;
    }

    return {
      ...recipe,
      url,
      source: "ah.be" as const,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    log("AH-Recipes", `  ❌ Fout: ${url} - ${err}`);
    return null;
  }
}

if (import.meta.main) {
  log("AH-Recipes", "=== AH.be Recepten Scraper ===");

  const { context, page } = await getAHContext();

  // Navigeer naar favorieten
  log("AH-Recipes", "Navigeren naar favorieten...");
  await page.goto(FAVORIETEN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForTimeout(3_000);

  // Check of we ingelogd zijn
  if (page.url().includes("inloggen")) {
    log("AH-Recipes", "");
    log("AH-Recipes", "Je bent niet ingelogd. Log handmatig in via de browser.");
    log("AH-Recipes", "Navigeer naar https://www.ah.be/allerhande/favorieten");
    log("AH-Recipes", "Typ 'ready' als je op de favorieten pagina bent.");
    log("AH-Recipes", "");

    const reader = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise<void>((resolve) => {
      const checkReady = () => {
        reader.question("Typ 'ready': ", (answer: string) => {
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

  // Verzamel alle links via paginatie
  const links = await getAllRecipeLinks(page);
  log("AH-Recipes", `${links.length} unieke recept-links gevonden`);

  // Sla links op
  await writeFile(join(DATA_DIR, "ah-recipe-links.json"), JSON.stringify(links, null, 2));

  if (links.length === 0) {
    log("AH-Recipes", "Geen recepten gevonden. Check of je op de juiste pagina bent.");
    // Dump HTML
    const html = await page.content();
    await writeFile(join(DATA_DIR, "ah-favorieten-debug.html"), html);
    await context.close();
    process.exit(1);
  }

  // Scrape eerste recept als test en dump HTML voor analyse
  log("AH-Recipes", "");
  log("AH-Recipes", "Test: eerste recept scrapen...");
  const firstLink = links[0]!;
  await page.goto(firstLink, { waitUntil: "domcontentloaded", timeout: 15_000 });
  // Wacht tot de pagina echt geladen is (voorbij Akamai challenge)
  try {
    await page.waitForSelector("h1", { timeout: 10_000 });
  } catch {
    log("AH-Recipes", "  ⚠️ h1 niet gevonden, page content toch opslaan");
  }
  const testHtml = await page.content();
  await writeFile(join(DATA_DIR, "ah-recipe-detail-sample.html"), testHtml);
  await screenshot(page, "ah-recipe-detail-sample");
  log("AH-Recipes", `Test recept HTML opgeslagen in data/ah-recipe-detail-sample.html`);

  // Ga terug en scrape alle recepten
  const recipes: Recipe[] = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    log("AH-Recipes", `[${i + 1}/${links.length}] ${link.split("/").pop()}`);
    const recipe = await scrapeRecipeDetail(page, link);
    if (recipe) {
      recipes.push(recipe);
      log("AH-Recipes", `  ✅ ${recipe.title} (${recipe.ingredients.length} ingrediënten, ${recipe.instructions.length} stappen)`);
    }

    // Rate limiting
    if (i < links.length - 1) {
      await page.waitForTimeout(500);
    }

    // Tussentijds opslaan elke 10 recepten
    if ((i + 1) % 10 === 0 || i === links.length - 1) {
      await writeFile(join(DATA_DIR, "ah-recipes.json"), JSON.stringify(recipes, null, 2));
      log("AH-Recipes", `  💾 Opgeslagen (${recipes.length} recepten)`);
    }
  }

  // Statistieken
  log("AH-Recipes", "");
  log("AH-Recipes", "=== Resultaat ===");
  log("AH-Recipes", `Totaal: ${recipes.length}/${links.length} recepten`);
  log("AH-Recipes", `Met ingrediënten: ${recipes.filter((r) => r.ingredients.length > 0).length}`);
  log("AH-Recipes", `Met instructies: ${recipes.filter((r) => r.instructions.length > 0).length}`);
  log("AH-Recipes", `Opgeslagen in data/ah-recipes.json`);

  await context.close();
}

export { getAllRecipeLinks, scrapeRecipeDetail };
export type { Recipe, Ingredient };
