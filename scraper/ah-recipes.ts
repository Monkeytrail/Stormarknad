import { type Page } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getAuthenticatedContext } from "./ah-login";
import { screenshot, log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

interface Ingredient {
  name: string;
  quantity: string;
  unit: string;
}

interface Recipe {
  title: string;
  url: string;
  imageUrl: string;
  ingredients: Ingredient[];
  instructions: string[];
  servings: number;
  prepTime: number | null;
  tags: string[];
  source: "ah.be";
  scrapedAt: string;
}

async function scrollToLoadAll(page: Page) {
  log("AH-Recipes", "Alle recepten laden door te scrollen...");
  let previousHeight = 0;
  let attempts = 0;

  while (attempts < 50) {
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

  log("AH-Recipes", "Klaar met scrollen");
}

async function getFavoriteRecipeLinks(page: Page): Promise<string[]> {
  log("AH-Recipes", "Navigeren naar favorieten...");
  await page.goto("https://www.ah.be/allerhande/favorieten");
  await page.waitForLoadState("networkidle");
  await screenshot(page, "ah-recipes-01-favorieten");

  // Scroll om alle recepten te laden (lazy loading)
  await scrollToLoadAll(page);
  await screenshot(page, "ah-recipes-02-all-loaded");

  // Zoek alle recept-links op de pagina
  // AH Allerhande recepten hebben typisch URLs als /allerhande/recept/...
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href*="/allerhande/recept/"]');
    return [...new Set(Array.from(anchors).map((a) => (a as HTMLAnchorElement).href))];
  });

  log("AH-Recipes", `${links.length} recept-links gevonden`);
  return links;
}

async function scrapeRecipeDetail(page: Page, url: string): Promise<Recipe | null> {
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const recipe = await page.evaluate(() => {
      // Titel
      const titleEl = document.querySelector("h1");
      const title = titleEl?.textContent?.trim() || "";

      // Afbeelding
      const imgEl = document.querySelector('img[src*="allerhande"], article img, [class*="recipe"] img');
      const imageUrl = (imgEl as HTMLImageElement)?.src || "";

      // Ingrediënten - probeer meerdere mogelijke structuren
      const ingredients: { name: string; quantity: string; unit: string }[] = [];
      const ingredientEls = document.querySelectorAll(
        '[class*="ingredient"], [data-testid*="ingredient"], li[class*="ingredient"]'
      );

      ingredientEls.forEach((el) => {
        const text = el.textContent?.trim() || "";
        if (text) {
          // Probeer hoeveelheid en eenheid te parsen: "200 g kipfilet"
          const match = text.match(/^([\d½¼¾⅓⅔,./]+)?\s*(g|kg|ml|l|el|tl|stuks?|teen|bos|takje|snuf|blik|pak|zak|plak|schijf)?\s*(.+)/i);
          if (match) {
            ingredients.push({
              quantity: match[1]?.trim() || "",
              unit: match[2]?.trim() || "",
              name: match[3]?.trim() || text,
            });
          } else {
            ingredients.push({ name: text, quantity: "", unit: "" });
          }
        }
      });

      // Instructies
      const instructions: string[] = [];
      const stepEls = document.querySelectorAll(
        '[class*="step"] p, [class*="preparation"] li, [data-testid*="step"], ol[class*="step"] li'
      );
      stepEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text) instructions.push(text);
      });

      // Porties
      const servingsEl = document.querySelector('[class*="serving"], [data-testid*="serving"]');
      const servingsText = servingsEl?.textContent?.trim() || "";
      const servingsMatch = servingsText.match(/(\d+)/);
      const servings = servingsMatch ? parseInt(servingsMatch[1]) : 4;

      // Bereidingstijd
      const timeEl = document.querySelector('[class*="time"], [data-testid*="time"], [class*="duration"]');
      const timeText = timeEl?.textContent?.trim() || "";
      const timeMatch = timeText.match(/(\d+)/);
      const prepTime = timeMatch ? parseInt(timeMatch[1]) : null;

      // Tags
      const tags: string[] = [];
      const tagEls = document.querySelectorAll('[class*="tag"] a, [class*="label"] a, [class*="category"] a');
      tagEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text) tags.push(text);
      });

      return { title, imageUrl, ingredients, instructions, servings, prepTime, tags };
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
    log("AH-Recipes", `  ❌ Fout bij scrapen: ${url} - ${err}`);
    return null;
  }
}

if (import.meta.main) {
  log("AH-Recipes", "=== AH.be Recepten Scraper ===");

  const { browser, page } = await getAuthenticatedContext();

  try {
    // Stap 1: Haal alle recept-links op
    const links = await getFavoriteRecipeLinks(page);

    if (links.length === 0) {
      log("AH-Recipes", "Geen recepten gevonden! Check de screenshots voor de pagina-structuur.");
      log("AH-Recipes", "Mogelijk is de selector niet juist. Bekijk de HTML in de browser.");

      // Dump de HTML voor analyse
      const html = await page.content();
      await writeFile(join(DATA_DIR, "ah-favorieten-page.html"), html);
      log("AH-Recipes", "HTML opgeslagen in data/ah-favorieten-page.html");
    } else {
      // Stap 2: Scrape elk recept
      const recipes: Recipe[] = [];
      for (let i = 0; i < links.length; i++) {
        log("AH-Recipes", `Scraping ${i + 1}/${links.length}: ${links[i]}`);
        const recipe = await scrapeRecipeDetail(page, links[i]);
        if (recipe) {
          recipes.push(recipe);
          log("AH-Recipes", `  ✅ ${recipe.title} (${recipe.ingredients.length} ingrediënten)`);
        }

        // Rate limiting: wacht even tussen requests
        if (i < links.length - 1) {
          await page.waitForTimeout(500);
        }

        // Tussentijds opslaan elke 10 recepten
        if ((i + 1) % 10 === 0) {
          await writeFile(join(DATA_DIR, "ah-recipes.json"), JSON.stringify(recipes, null, 2));
          log("AH-Recipes", `  💾 Tussentijds opgeslagen (${recipes.length} recepten)`);
        }
      }

      // Sla alle recepten op
      await writeFile(join(DATA_DIR, "ah-recipes.json"), JSON.stringify(recipes, null, 2));
      log("AH-Recipes", `\n=== Klaar! ${recipes.length} recepten opgeslagen in data/ah-recipes.json ===`);

      // Statistieken
      const withIngredients = recipes.filter((r) => r.ingredients.length > 0).length;
      const withInstructions = recipes.filter((r) => r.instructions.length > 0).length;
      log("AH-Recipes", `Recepten met ingrediënten: ${withIngredients}/${recipes.length}`);
      log("AH-Recipes", `Recepten met instructies: ${withInstructions}/${recipes.length}`);
    }
  } finally {
    log("AH-Recipes", "Browser sluiten...");
    await browser.close();
  }
}

export { getFavoriteRecipeLinks, scrapeRecipeDetail };
export type { Recipe, Ingredient };
