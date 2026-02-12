import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getAHContext } from "./ah-login";
import { scrapeRecipeDetail, type Recipe } from "./ah-recipes";
import { log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

const ALLERHANDE_URL = "https://www.ah.be/allerhande";
const MAX_PAGES = 10;

if (import.meta.main) {
  log("AH-Discover", "=== AH Allerhande Discover Scraper ===");

  // Laad bestaande favorieten URLs om te skippen
  const existingUrls = new Set<string>();
  const favPath = join(DATA_DIR, "ah-recipes.json");
  if (existsSync(favPath)) {
    const favs = JSON.parse(await readFile(favPath, "utf-8"));
    for (const r of favs) {
      existingUrls.add(r.url);
    }
    log("AH-Discover", `${existingUrls.size} bestaande favorieten geladen (worden overgeslagen)`);
  }

  const { context, page } = await getAHContext();

  try {
    // Verzamel links van meerdere pagina's
    const allLinks = new Set<string>();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const url = pageNum === 1 ? ALLERHANDE_URL : `${ALLERHANDE_URL}?page=${pageNum}`;
      log("AH-Discover", `Pagina ${pageNum} laden: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(2_000);

      const links = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href*="/allerhande/recept/"]');
        return [...new Set(Array.from(anchors).map((a) => (a as HTMLAnchorElement).href))];
      });

      if (links.length === 0) {
        log("AH-Discover", `  Geen recepten op pagina ${pageNum}, klaar.`);
        break;
      }

      const before = allLinks.size;
      for (const l of links) {
        if (!existingUrls.has(l)) {
          allLinks.add(l);
        }
      }
      const newCount = allLinks.size - before;
      log("AH-Discover", `  ${links.length} links gevonden (${newCount} nieuw, ${links.length - newCount} overgeslagen)`);

      if (newCount === 0) break;
    }

    log("AH-Discover", `Totaal: ${allLinks.size} nieuwe recept-links`);

    if (allLinks.size === 0) {
      log("AH-Discover", "Geen nieuwe recepten gevonden.");
    } else {
      // Scrape details
      const recipes: Recipe[] = [];
      const links = [...allLinks];

      for (let i = 0; i < links.length; i++) {
        const link = links[i]!;
        log("AH-Discover", `[${i + 1}/${links.length}] ${link.split("/").pop()}`);
        const recipe = await scrapeRecipeDetail(page, link);
        if (recipe) {
          recipes.push(recipe);
          log("AH-Discover", `  ${recipe.title} (${recipe.ingredients.length} ingr., ${recipe.instructions.length} stappen)`);
        }

        if (i < links.length - 1) {
          await page.waitForTimeout(500);
        }

        if ((i + 1) % 10 === 0 || i === links.length - 1) {
          await writeFile(join(DATA_DIR, "ah-discover.json"), JSON.stringify(recipes, null, 2));
          log("AH-Discover", `  Opgeslagen (${recipes.length} recepten)`);
        }
      }

      log("AH-Discover", "");
      log("AH-Discover", "=== Resultaat ===");
      log("AH-Discover", `Totaal: ${recipes.length}/${links.length} recepten`);
      log("AH-Discover", `Met ingrediënten: ${recipes.filter((r) => r.ingredients.length > 0).length}`);
      log("AH-Discover", `Met instructies: ${recipes.filter((r) => r.instructions.length > 0).length}`);
      log("AH-Discover", `Opgeslagen in data/ah-discover.json`);
    }
  } finally {
    await context.close();
  }
}
