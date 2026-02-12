import { type Page } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getDeMorgenContext } from "./demorgen-login";
import { screenshot, log } from "./utils";

const DATA_DIR = join(import.meta.dir, "..", "data");
await mkdir(DATA_DIR, { recursive: true });

const FAVORIETEN_URL = "https://koken.demorgen.be/mijn-favoriete-recepten/";

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
  // Als we nog niet op de favorieten pagina zijn, navigeer erheen
  if (!page.url().includes("koken.demorgen.be/mijn-favoriete-recepten")) {
    log("DM-Recipes", "Navigeren naar favorieten...");
    await page.goto(FAVORIETEN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await page.waitForTimeout(5_000);
  }

  log("DM-Recipes", `Huidige URL: ${page.url()}`);

  // Dump HTML voor analyse
  const html = await page.content();
  await writeFile(join(DATA_DIR, "dm-favorieten-page.html"), html);
  await screenshot(page, "dm-recipes-01-favorieten");
  log("DM-Recipes", "HTML opgeslagen in data/dm-favorieten-page.html");

  // Scroll om alle recepten te laden (mogelijk lazy loading)
  let previousHeight = 0;
  let stableRounds = 0;
  while (stableRounds < 3) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_500);
  }

  // Zoek recept-links (alleen kaart-links, geen navigatie/labels/footer)
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a.card-recept-link[href*="/recepten/"]');
    return [...new Set(Array.from(anchors).map((a) => (a as HTMLAnchorElement).href))];
  });

  log("DM-Recipes", `${links.length} recept-links gevonden`);
  return links;
}

async function scrapeRecipeDetail(page: Page, url: string): Promise<DeMorgenRecipe | null> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(2_000);

    const recipe = await page.evaluate(() => {
      // Check of dit een recept-pagina is (niet index/categorie)
      if (!document.body.classList.contains("single-recepten")) {
        return null;
      }

      // Haal JSON-LD structured data op (Yoast SEO)
      const ldScript = document.querySelector("script.yoast-schema-graph");
      let ldData: any = null;
      if (ldScript?.textContent) {
        try {
          const schema = JSON.parse(ldScript.textContent);
          ldData = schema["@graph"]?.find((item: any) => {
            const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
            return types.includes("Recipe");
          });
        } catch {}
      }

      // Titel
      const titleEl = document.querySelector("h1.s-recepten-title, h1");
      const title = titleEl?.textContent?.trim() || ldData?.name || "";

      // Afbeelding
      const imgEl = document.querySelector("article.s-recepten img, .s-image img");
      const imageUrl = (imgEl as HTMLImageElement)?.src || "";

      // Ingrediënten uit HTML (bevat hoeveelheden)
      const ingredients: { name: string; quantity: string; unit: string }[] = [];
      document.querySelectorAll(".s-ingr-set li").forEach((li) => {
        const nameEl = li.querySelector("div:first-child");
        const name = nameEl?.textContent?.trim() || "";
        if (!name) return;

        const qtyEl = li.querySelector(".s-ingr-result");
        const quantity = qtyEl?.textContent?.trim() || "";
        // Eenheid is de laatste span in s-ingr-item (na s-ingr-result)
        let unit = "";
        const spans = li.querySelectorAll(".s-ingr-item span.t-700");
        const lastSpan = spans[spans.length - 1];
        if (lastSpan && !lastSpan.classList.contains("s-ingr-result") && !lastSpan.classList.contains("s-ingr-x")) {
          unit = lastSpan.textContent?.trim() || "";
        }

        ingredients.push({ name, quantity, unit });
      });

      // Fallback: JSON-LD recipeIngredient (alleen namen, geen hoeveelheden)
      if (ingredients.length === 0 && ldData?.recipeIngredient) {
        for (const raw of ldData.recipeIngredient) {
          const text = String(raw).trim();
          if (!text) continue;
          // Probeer hoeveelheid/eenheid te splitsen: "200 g bloem" → qty=200, unit=g, name=bloem
          const match = text.match(/^([\d.,/½¼¾⅓⅔]+)\s*(ml|cl|dl|l|g|kg|el|tl|eetlepel|theelepel|stuks?|snuf|snufje|takje|takjes|teen|tenen|blaadjes?|plakjes?|schijfjes?)?\s+(.+)$/i);
          if (match) {
            ingredients.push({ name: match[3]!.trim(), quantity: match[1]!.trim(), unit: (match[2] || "").trim() });
          } else {
            ingredients.push({ name: text, quantity: "", unit: "" });
          }
        }
      }

      // Instructies uit JSON-LD
      const instructions = (ldData?.recipeInstructions || [])
        .map((step: any) => {
          const text = (typeof step === "string" ? step : step.text || "").replace(/<[^>]*>/g, "").trim();
          return text;
        })
        .filter((t: string) => t.length > 0);

      // Porties uit HTML (#calc-x) of JSON-LD
      const calcEl = document.querySelector("#calc-x");
      const calcMatch = calcEl?.textContent?.match(/(\d+)/);
      const servingsRaw = ldData?.recipeYield;
      const servingsMatch = calcMatch || String(servingsRaw || "").match(/(\d+)/);
      const servings = servingsMatch ? parseInt(servingsMatch[1]!) : 4;

      // Bereidingstijd uit JSON-LD (ISO 8601: PT20M) of HTML
      let prepTime: number | null = null;
      const totalTime = ldData?.totalTime || "";
      const timeMatch = totalTime.match(/PT(\d+)M/);
      if (timeMatch) {
        prepTime = parseInt(timeMatch[1]!);
      } else {
        const timeEl = document.querySelector("span.preparation-time");
        const htmlTimeMatch = timeEl?.textContent?.match(/(\d+)/);
        if (htmlTimeMatch) prepTime = parseInt(htmlTimeMatch[1]!);
      }

      // Tags uit JSON-LD keywords of HTML recept-labels
      const tags: string[] = [];
      const seenTags = new Set<string>();
      if (ldData?.keywords) {
        String(ldData.keywords)
          .split(",")
          .forEach((kw: string) => {
            const t = kw.trim();
            if (t && !seenTags.has(t)) {
              seenTags.add(t);
              tags.push(t);
            }
          });
      }
      if (tags.length === 0) {
        document.querySelectorAll(".recept-labels a.tag-box").forEach((el) => {
          const text = el.textContent?.trim();
          if (text && !seenTags.has(text)) {
            seenTags.add(text);
            tags.push(text);
          }
        });
      }

      return { title, imageUrl, ingredients, instructions, servings, prepTime, tags };
    });

    if (!recipe) {
      log("DM-Recipes", `  ⏭️ Geen recept-pagina: ${url}`);
      return null;
    }

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
    log("DM-Recipes", `  ❌ Fout: ${url} - ${err}`);
    return null;
  }
}

if (import.meta.main) {
  log("DM-Recipes", "=== koken.demorgen Recepten Scraper ===");

  const { context, page } = await getDeMorgenContext();

  // Navigeer naar favorieten en check of we ingelogd zijn
  log("DM-Recipes", "Navigeren naar favorieten...");
  await page.goto(FAVORIETEN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForTimeout(5_000);

  log("DM-Recipes", `Huidige URL: ${page.url()}`);

  // Check of er recept-kaarten op de pagina staan (= ingelogd)
  const hasRecipes = await page.evaluate(() => {
    const links = document.querySelectorAll('a.card-recept-link[href*="/recepten/"]');
    return links.length > 0;
  });

  if (!hasRecipes) {
    log("DM-Recipes", "");
    log("DM-Recipes", "Geen recepten gevonden - je bent waarschijnlijk niet ingelogd.");
    log("DM-Recipes", "Log handmatig in via de browser.");
    log("DM-Recipes", "Navigeer naar https://koken.demorgen.be/mijn-favoriete-recepten/");
    log("DM-Recipes", "Typ 'ready' als je ingelogd bent en je favorieten ziet.");
    log("DM-Recipes", "");

    const reader = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise<void>((resolve) => {
      const checkReady = () => {
        reader.question("[DM-Recipes] Typ 'ready': ", (answer: string) => {
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

  try {
    const links = await getFavoriteLinks(page);

    if (links.length === 0) {
      log("DM-Recipes", "Geen recepten gevonden. Check data/dm-favorieten-page.html en screenshots.");
    } else {
      // Dump eerste recept HTML voor analyse
      log("DM-Recipes", "Test: eerste recept HTML opslaan...");
      await page.goto(links[0]!, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForTimeout(2_000);
      const testHtml = await page.content();
      await writeFile(join(DATA_DIR, "dm-recipe-detail-sample.html"), testHtml);
      await screenshot(page, "dm-recipe-detail-sample");

      const recipes: DeMorgenRecipe[] = [];
      for (let i = 0; i < links.length; i++) {
        const link = links[i]!;
        log("DM-Recipes", `[${i + 1}/${links.length}] ${link.split("/").pop()}`);
        const recipe = await scrapeRecipeDetail(page, link);
        if (recipe) {
          recipes.push(recipe);
          log("DM-Recipes", `  ✅ ${recipe.title} (${recipe.ingredients.length} ingrediënten, ${recipe.instructions.length} stappen)`);
        }

        if (i < links.length - 1) {
          await page.waitForTimeout(500);
        }

        if ((i + 1) % 10 === 0 || i === links.length - 1) {
          await writeFile(join(DATA_DIR, "dm-recipes.json"), JSON.stringify(recipes, null, 2));
          log("DM-Recipes", `  💾 Opgeslagen (${recipes.length} recepten)`);
        }
      }

      log("DM-Recipes", "");
      log("DM-Recipes", "=== Resultaat ===");
      log("DM-Recipes", `Totaal: ${recipes.length}/${links.length} recepten`);
      log("DM-Recipes", `Met ingrediënten: ${recipes.filter((r) => r.ingredients.length > 0).length}`);
      log("DM-Recipes", `Met instructies: ${recipes.filter((r) => r.instructions.length > 0).length}`);
      log("DM-Recipes", `Opgeslagen in data/dm-recipes.json`);
    }
  } finally {
    await context.close();
  }
}

export { getFavoriteLinks, scrapeRecipeDetail };
export type { DeMorgenRecipe };
