import { type Page, chromium } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");

await mkdir(DATA_DIR, { recursive: true });

const TAG_URL = "https://15gram.be/tag/hoofdgerecht";
const MAX_PAGES = 200; // veiligheidslimiet

interface GramRecipe {
  title: string;
  url: string;
  imageUrl: string;
  ingredients: { name: string; quantity: string; unit: string; raw: string }[];
  instructions: string[];
  servings: number;
  prepTime: number | null;
  calories: null;
  tags: string[];
  source: "15gram.be";
  scrapedAt: string;
}

// Parse "125 gr. volkoren rijst" → { quantity: "125", unit: "gr.", name: "volkoren rijst" }
function parseIngredient(raw: string): { name: string; quantity: string; unit: string } {
  const text = raw.trim();
  const match = text.match(
    /^([\d½¼¾⅓⅔,.\/]+)?\s*(gr\.|g\.|g|kg|ml|cl|dl|l|el\.|el|tl\.|tl|stuks?|snuf[je]*|takjes?|teen|tenen|blaadjes?|plakjes?|schijfjes?|theelepels?|eetlepels?|zakjes?|blikjes?|bosjes?|handvol)?\s*(.+)$/i
  );
  if (match) {
    return {
      quantity: match[1]?.trim() || "",
      unit: match[2]?.trim() || "",
      name: match[3]?.trim() || text,
    };
  }
  return { quantity: "", unit: "", name: text };
}

async function getRecipeLinksFromPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href*="/recepten/"]');
    return [...new Set(
      Array.from(anchors)
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((href) => /\/recepten\/[^/?]+$/.test(href)) // test full href to exclude search?q=... URLs
    )];
  });
}

async function scrapeRecipeDetail(page: Page, url: string): Promise<GramRecipe | null> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1_000);

    const recipe = await page.evaluate(() => {
      const title = document.querySelector("h1")?.textContent?.trim() || "";

      const imgEl = document.querySelector('img[src*="image.15gram.be"]');
      const imageUrl = (imgEl as HTMLImageElement)?.src || "";

      let servings = 4;
      const bodyText = document.body.innerText;
      const servingsMatch = bodyText.match(/(\d+)\s+personen/i);
      if (servingsMatch) servings = parseInt(servingsMatch[1]!);

      let prepTime: number | null = null;
      const timeMatch = bodyText.match(/(\d+)\s*MIN/i);
      if (timeMatch) prepTime = parseInt(timeMatch[1]!);

      // Ingredients: <ul> after <h3> containing "Ingrediënten" (may be wrapped in a div)
      const ingredientRaws: string[] = [];
      const h3s = Array.from(document.querySelectorAll("h3"));
      for (const h3 of h3s) {
        if (h3.textContent?.toLowerCase().includes("ingredi")) {
          const sibling = h3.nextElementSibling;
          // ul can be the direct sibling, or nested inside a div sibling
          const ul = sibling?.tagName === "UL"
            ? sibling
            : sibling?.querySelector?.("ul") ?? null;
          if (ul) {
            ul.querySelectorAll("li").forEach((li) => {
              const text = li.textContent?.trim();
              if (text) ingredientRaws.push(text);
            });
          }
          break;
        }
      }

      // Instructions: <ol> after <h3> containing "bereiding"
      const instructions: string[] = [];
      for (const h3 of h3s) {
        if (h3.textContent?.toLowerCase().includes("bereiding")) {
          let sibling = h3.nextElementSibling;
          while (sibling && sibling.tagName !== "OL") sibling = sibling.nextElementSibling;
          if (sibling?.tagName === "OL") {
            sibling.querySelectorAll("li").forEach((li) => {
              const text = li.textContent?.trim();
              if (text && text.length > 5) instructions.push(text);
            });
          }
          break;
        }
      }

      // Tags: links to /tag/[tagname]
      const tags: string[] = [];
      const seenTags = new Set<string>();
      document.querySelectorAll('a[href*="/tag/"]').forEach((a) => {
        const text = a.textContent?.trim();
        if (text && text.length < 50 && !seenTags.has(text)) {
          seenTags.add(text);
          tags.push(text);
        }
      });

      return { title, imageUrl, servings, prepTime, ingredientRaws, instructions, tags };
    });

    if (!recipe.title) {
      log("15gram", `  ⚠️ Geen titel: ${url}`);
      return null;
    }

    const ingredients = recipe.ingredientRaws.map((raw) => ({
      ...parseIngredient(raw),
      raw,
    }));

    return {
      title: recipe.title,
      url,
      imageUrl: recipe.imageUrl,
      ingredients,
      instructions: recipe.instructions,
      servings: recipe.servings,
      prepTime: recipe.prepTime,
      calories: null,
      tags: recipe.tags,
      source: "15gram.be" as const,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    log("15gram", `  ❌ Fout: ${url} - ${err}`);
    return null;
  }
}

if (import.meta.main) {
  log("15gram", "=== 15gram.be Hoofdgerecht Scraper ===");

  const context = await chromium.launch({ headless: true });
  const page = await context.newPage();

  try {
    // ── Verzamel alle recept-links via paginatie ──────────────
    const allLinks = new Set<string>();
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = pageNum === 1 ? TAG_URL : `${TAG_URL}?page=${pageNum}`;
      log("15gram", `Pagina ${pageNum} laden...`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(1_000);

      const links = await getRecipeLinksFromPage(page);
      if (links.length === 0) {
        log("15gram", `  Geen recepten op pagina ${pageNum}, klaar.`);
        break;
      }

      const before = allLinks.size;
      links.forEach((l) => allLinks.add(l));
      const newCount = allLinks.size - before;
      log("15gram", `  ${links.length} gevonden (${newCount} nieuw) — totaal: ${allLinks.size}`);

      if (newCount === 0) break;
    }

    const links = [...allLinks];
    log("15gram", `${links.length} unieke recept-links gevonden`);
    await writeFile(join(DATA_DIR, "15gram-recipe-links.json"), JSON.stringify(links, null, 2));

    if (links.length === 0) {
      log("15gram", "Geen recepten gevonden.");
      process.exit(1);
    }

    // ── Scrape elk recept ─────────────────────────────────────
    const recipes: GramRecipe[] = [];
    for (let i = 0; i < links.length; i++) {
      const link = links[i]!;
      log("15gram", `[${i + 1}/${links.length}] ${link.split("/").pop()}`);
      const recipe = await scrapeRecipeDetail(page, link);
      if (recipe) {
        recipes.push(recipe);
        log("15gram", `  ✅ ${recipe.title} (${recipe.ingredients.length} ing, ${recipe.instructions.length} stappen)`);
      }

      if (i < links.length - 1) await page.waitForTimeout(300);

      if ((i + 1) % 10 === 0 || i === links.length - 1) {
        await writeFile(join(DATA_DIR, "15gram-recipes.json"), JSON.stringify(recipes, null, 2));
        log("15gram", `  💾 Opgeslagen (${recipes.length} recepten)`);
      }
    }

    log("15gram", "");
    log("15gram", "=== Resultaat ===");
    log("15gram", `Totaal: ${recipes.length}/${links.length} recepten`);
    log("15gram", `Met ingrediënten: ${recipes.filter((r) => r.ingredients.length > 0).length}`);
    log("15gram", `Met instructies: ${recipes.filter((r) => r.instructions.length > 0).length}`);
    log("15gram", `Opgeslagen in data/15gram-recipes.json`);
  } finally {
    await context.close();
  }
}

export { scrapeRecipeDetail };
export type { GramRecipe };
