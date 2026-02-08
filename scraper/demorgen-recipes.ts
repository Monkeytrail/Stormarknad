import { type Page } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getAuthenticatedDeMorgenContext } from "./demorgen-login";
import { screenshot, log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

interface DeMorgenRecipe {
  title: string;
  url: string;
  imageUrl: string;
  ingredients: { name: string; quantity: string; unit: string }[];
  instructions: string[];
  servings: number;
  prepTime: number | null;
  tags: string[];
  source: "koken.demorgen";
  scrapedAt: string;
}

async function getFavoriteLinks(page: Page): Promise<string[]> {
  log("DM-Recipes", "Navigeren naar favorieten...");

  // De exacte URL zal tijdens verkenning bepaald worden
  // Probeer de meest waarschijnlijke
  await page.goto("https://koken.demorgen.be/favorieten");
  await page.waitForLoadState("networkidle");
  await screenshot(page, "dm-recipes-01-favorieten");

  // Zoek recept-links
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href*="/recept/"], a[href*="/recepten/"]');
    return [...new Set(Array.from(anchors).map((a) => (a as HTMLAnchorElement).href))];
  });

  log("DM-Recipes", `${links.length} recept-links gevonden`);
  return links;
}

async function scrapeRecipeDetail(page: Page, url: string): Promise<DeMorgenRecipe | null> {
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const recipe = await page.evaluate(() => {
      const titleEl = document.querySelector("h1");
      const title = titleEl?.textContent?.trim() || "";

      const imgEl = document.querySelector('article img, [class*="recipe"] img, [class*="hero"] img');
      const imageUrl = (imgEl as HTMLImageElement)?.src || "";

      // Ingrediënten
      const ingredients: { name: string; quantity: string; unit: string }[] = [];
      const ingredientEls = document.querySelectorAll(
        '[class*="ingredient"] li, [class*="ingredient"], ul[class*="ingredient"] li'
      );

      ingredientEls.forEach((el) => {
        const text = el.textContent?.trim() || "";
        if (text) {
          const match = text.match(/^([\d½¼¾⅓⅔,./]+)?\s*(g|kg|ml|l|cl|dl|el|tl|stuks?|teen|bos|takje|snuf|blik|pak)?\s*(.+)/i);
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
        '[class*="step"] p, [class*="preparation"] li, [class*="instruction"] li, ol li'
      );
      stepEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length > 10) instructions.push(text);
      });

      // Porties
      const servingsEl = document.querySelector('[class*="serving"], [class*="portie"], [class*="person"]');
      const servingsText = servingsEl?.textContent?.trim() || "";
      const servingsMatch = servingsText.match(/(\d+)/);
      const servings = servingsMatch ? parseInt(servingsMatch[1]) : 4;

      // Bereidingstijd
      const timeEl = document.querySelector('[class*="time"], [class*="duur"], [class*="duration"]');
      const timeText = timeEl?.textContent?.trim() || "";
      const timeMatch = timeText.match(/(\d+)/);
      const prepTime = timeMatch ? parseInt(timeMatch[1]) : null;

      // Tags
      const tags: string[] = [];
      const tagEls = document.querySelectorAll('[class*="tag"] a, [class*="categor"] a');
      tagEls.forEach((el) => {
        const text = el.textContent?.trim();
        if (text) tags.push(text);
      });

      return { title, imageUrl, ingredients, instructions, servings, prepTime, tags };
    });

    if (!recipe.title) {
      log("DM-Recipes", `  ⚠️ Geen titel gevonden voor ${url}`);
      return null;
    }

    return {
      ...recipe,
      url,
      source: "koken.demorgen" as const,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    log("DM-Recipes", `  ❌ Fout bij scrapen: ${url} - ${err}`);
    return null;
  }
}

if (import.meta.main) {
  log("DM-Recipes", "=== koken.demorgen Recepten Scraper ===");

  const { browser, page } = await getAuthenticatedDeMorgenContext();

  try {
    const links = await getFavoriteLinks(page);

    if (links.length === 0) {
      log("DM-Recipes", "Geen recepten gevonden! Check screenshots.");

      const html = await page.content();
      await writeFile(join(DATA_DIR, "dm-favorieten-page.html"), html);
      log("DM-Recipes", "HTML opgeslagen in data/dm-favorieten-page.html");
    } else {
      const recipes: DeMorgenRecipe[] = [];
      for (let i = 0; i < links.length; i++) {
        log("DM-Recipes", `Scraping ${i + 1}/${links.length}: ${links[i]}`);
        const recipe = await scrapeRecipeDetail(page, links[i]);
        if (recipe) {
          recipes.push(recipe);
          log("DM-Recipes", `  ✅ ${recipe.title} (${recipe.ingredients.length} ingrediënten)`);
        }

        if (i < links.length - 1) {
          await page.waitForTimeout(500);
        }

        if ((i + 1) % 10 === 0) {
          await writeFile(join(DATA_DIR, "dm-recipes.json"), JSON.stringify(recipes, null, 2));
          log("DM-Recipes", `  💾 Tussentijds opgeslagen (${recipes.length} recepten)`);
        }
      }

      await writeFile(join(DATA_DIR, "dm-recipes.json"), JSON.stringify(recipes, null, 2));
      log("DM-Recipes", `\n=== Klaar! ${recipes.length} recepten opgeslagen in data/dm-recipes.json ===`);
    }
  } finally {
    await browser.close();
  }
}

export { getFavoriteLinks, scrapeRecipeDetail };
export type { DeMorgenRecipe };
