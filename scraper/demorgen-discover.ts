import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getDeMorgenContext } from "./demorgen-login";
import { scrapeRecipeDetail, type DeMorgenRecipe } from "./demorgen-recipes";
import { log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

const RECEPTEN_URL = "https://koken.demorgen.be/recept/soort-gerecht/hoofdgerecht/";
const MAX_SCROLLS = 20;

if (import.meta.main) {
  log("DM-Discover", "=== koken.demorgen Discover Scraper ===");

  // Laad bestaande favorieten URLs om te skippen
  const existingUrls = new Set<string>();
  const favPath = join(DATA_DIR, "dm-recipes.json");
  if (existsSync(favPath)) {
    const favs = JSON.parse(await readFile(favPath, "utf-8"));
    for (const r of favs) {
      existingUrls.add(r.url);
    }
    log("DM-Discover", `${existingUrls.size} bestaande favorieten geladen (worden overgeslagen)`);
  }

  const { context, page } = await getDeMorgenContext();

  try {
    // Navigeer naar recepten overzicht
    log("DM-Discover", `Laden: ${RECEPTEN_URL}`);
    await page.goto(RECEPTEN_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(3_000);

    // Scroll om meer recepten te laden (lazy loading)
    const allLinks = new Set<string>();
    let previousCount = 0;
    let stableRounds = 0;

    for (let scroll = 0; scroll < MAX_SCROLLS && stableRounds < 3; scroll++) {
      const links = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a.card-recept-link[href*="/recepten/"]');
        return [...new Set(Array.from(anchors).map((a) => (a as HTMLAnchorElement).href))];
      });

      for (const l of links) {
        if (!existingUrls.has(l)) {
          allLinks.add(l);
        }
      }

      if (allLinks.size === previousCount) {
        stableRounds++;
      } else {
        stableRounds = 0;
      }
      previousCount = allLinks.size;

      log("DM-Discover", `Scroll ${scroll + 1}: ${links.length} links op pagina, ${allLinks.size} nieuwe totaal`);

      // Scroll naar beneden
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2_000);

      // Klik "meer laden" knop als die er is
      try {
        const moreBtn = await page.$('a.btn-load-more, button.load-more, [class*="load-more"]');
        if (moreBtn) {
          await moreBtn.click();
          await page.waitForTimeout(2_000);
          log("DM-Discover", "  'Meer laden' knop geklikt");
        }
      } catch {}
    }

    log("DM-Discover", `Totaal: ${allLinks.size} nieuwe recept-links`);

    if (allLinks.size === 0) {
      log("DM-Discover", "Geen nieuwe recepten gevonden.");
    } else {
      // Scrape details
      const recipes: DeMorgenRecipe[] = [];
      const links = [...allLinks];

      for (let i = 0; i < links.length; i++) {
        const link = links[i]!;
        log("DM-Discover", `[${i + 1}/${links.length}] ${link.split("/").pop()}`);
        const recipe = await scrapeRecipeDetail(page, link);
        if (recipe) {
          recipes.push(recipe);
          log("DM-Discover", `  ${recipe.title} (${recipe.ingredients.length} ingr., ${recipe.instructions.length} stappen)`);
        }

        if (i < links.length - 1) {
          await page.waitForTimeout(500);
        }

        if ((i + 1) % 10 === 0 || i === links.length - 1) {
          await writeFile(join(DATA_DIR, "dm-discover.json"), JSON.stringify(recipes, null, 2));
          log("DM-Discover", `  Opgeslagen (${recipes.length} recepten)`);
        }
      }

      log("DM-Discover", "");
      log("DM-Discover", "=== Resultaat ===");
      log("DM-Discover", `Totaal: ${recipes.length}/${links.length} recepten`);
      log("DM-Discover", `Met ingrediënten: ${recipes.filter((r) => r.ingredients.length > 0).length}`);
      log("DM-Discover", `Met instructies: ${recipes.filter((r) => r.instructions.length > 0).length}`);
      log("DM-Discover", `Opgeslagen in data/dm-discover.json`);
    }
  } finally {
    await context.close();
  }
}
