import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { createClient, type InStatement } from "@libsql/client";

const DATA_DIR = join(import.meta.dir, "../../../data");

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ─── Lees JSON bestanden ─────────────────────────────────
console.log("Lezen van JSON data...");
const ahRecipes = JSON.parse(await readFile(join(DATA_DIR, "ah-recipes.json"), "utf-8"));
const dmRecipes = JSON.parse(await readFile(join(DATA_DIR, "dm-recipes.json"), "utf-8"));
const ahBonuses = JSON.parse(await readFile(join(DATA_DIR, "ah-bonuses.json"), "utf-8"));

// Discover recepten (optioneel)
const ahDiscoverPath = join(DATA_DIR, "ah-discover.json");
const dmDiscoverPath = join(DATA_DIR, "dm-discover.json");
const ahDiscover = existsSync(ahDiscoverPath)
  ? JSON.parse(await readFile(ahDiscoverPath, "utf-8"))
  : [];
const dmDiscover = existsSync(dmDiscoverPath)
  ? JSON.parse(await readFile(dmDiscoverPath, "utf-8"))
  : [];

console.log(`  AH favorieten:  ${ahRecipes.length}`);
console.log(`  DM favorieten:  ${dmRecipes.length}`);
console.log(`  AH discover:    ${ahDiscover.length}`);
console.log(`  DM discover:    ${dmDiscover.length}`);
console.log(`  AH bonussen:    ${ahBonuses.length}`);

// ─── Bouw alle SQL statements op ─────────────────────────
const statements: InStatement[] = [];

// Bewaar menu data: sla oude recipe URL mappings op voor remapping
const oldMenuSlots = await client.execute(
  "SELECT ms.id as slot_id, ms.menu_week_id, ms.day_of_week, r.url FROM menu_slots ms JOIN recipes r ON ms.recipe_id = r.id"
);
console.log(`  Menu slots bewaard: ${oldMenuSlots.rows.length}`);

// Verwijder bestaande data (behalve menu_weeks)
statements.push("DELETE FROM menu_slots");
statements.push("DELETE FROM recipe_tags");
statements.push("DELETE FROM tags");
statements.push("DELETE FROM instructions");
statements.push("DELETE FROM ingredients");
statements.push("DELETE FROM bonuses");
statements.push("DELETE FROM recipes");

// Tag cache voor deduplicatie
const tagMap = new Map<string, number>();
let tagId = 1;

// Favorieten eerst, dan discover (duplicaten op URL worden overgeslagen)
const seenUrls = new Set<string>();
const allRecipesWithFav: { recipe: any; isFavorite: boolean }[] = [];

for (const r of [...ahRecipes, ...dmRecipes]) {
  if (!seenUrls.has(r.url)) {
    seenUrls.add(r.url);
    allRecipesWithFav.push({ recipe: r, isFavorite: true });
  }
}
for (const r of [...ahDiscover, ...dmDiscover]) {
  if (!seenUrls.has(r.url)) {
    seenUrls.add(r.url);
    allRecipesWithFav.push({ recipe: r, isFavorite: false });
  }
}

console.log(`  Totaal uniek:   ${allRecipesWithFav.length} recepten (${allRecipesWithFav.filter(x => x.isFavorite).length} fav, ${allRecipesWithFav.filter(x => !x.isFavorite).length} discover)`);

for (const { recipe: r, isFavorite } of allRecipesWithFav) {
  statements.push({
    sql: `INSERT INTO recipes (title, url, image_url, servings, prep_time, calories, source, scraped_at, is_favorite)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.title,
      r.url,
      r.imageUrl || "",
      r.servings || 4,
      r.prepTime ?? null,
      r.calories ?? null,
      r.source,
      r.scrapedAt,
      isFavorite ? 1 : 0,
    ],
  });
}

console.log("Recepten statements opgebouwd...");

// Voer recepten batch uit en haal IDs op
const recipeResults = await client.batch(statements, "write");
console.log("Recepten geïnsereerd, nu gerelateerde data...");

// Haal de echte recipe IDs op
const allRecipes = allRecipesWithFav.map(x => x.recipe);
const recipeRows = await client.execute("SELECT id, url FROM recipes ORDER BY id");
const urlToId = new Map<string, number>();
for (const row of recipeRows.rows) {
  urlToId.set(row.url as string, row.id as number);
}

// ─── Ingrediënten, instructies, tags in batches ──────────
const BATCH_SIZE = 80; // libSQL batch limiet
let batch: InStatement[] = [];

async function flushBatch() {
  if (batch.length === 0) return;
  await client.batch(batch, "write");
  batch = [];
}

for (const r of allRecipes) {
  const id = urlToId.get(r.url);
  if (!id) continue;

  // Ingrediënten
  for (let i = 0; i < r.ingredients.length; i++) {
    const ing = r.ingredients[i]!;
    batch.push({
      sql: `INSERT INTO ingredients (recipe_id, name, quantity, unit, raw_text, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, ing.name, ing.quantity || "", ing.unit || "", ing.raw || "", i],
    });
    if (batch.length >= BATCH_SIZE) await flushBatch();
  }

  // Instructies
  for (let i = 0; i < r.instructions.length; i++) {
    batch.push({
      sql: `INSERT INTO instructions (recipe_id, step_number, text) VALUES (?, ?, ?)`,
      args: [id, i + 1, r.instructions[i]!],
    });
    if (batch.length >= BATCH_SIZE) await flushBatch();
  }

  // Tags
  for (const tagName of r.tags ?? []) {
    const normalized = tagName.toLowerCase().trim();
    if (!normalized) continue;

    if (!tagMap.has(normalized)) {
      tagMap.set(normalized, tagId++);
      batch.push({
        sql: `INSERT OR IGNORE INTO tags (name) VALUES (?)`,
        args: [normalized],
      });
      if (batch.length >= BATCH_SIZE) await flushBatch();
    }
  }
}

await flushBatch();
console.log("Ingrediënten, instructies en tags geïnsereerd...");

// Tags koppelen aan recepten - haal eerst echte tag IDs op
const tagRows = await client.execute("SELECT id, name FROM tags");
const tagNameToId = new Map<string, number>();
for (const row of tagRows.rows) {
  tagNameToId.set(row.name as string, row.id as number);
}

for (const r of allRecipes) {
  const recId = urlToId.get(r.url);
  if (!recId) continue;

  for (const tagName of r.tags ?? []) {
    const normalized = tagName.toLowerCase().trim();
    const tId = tagNameToId.get(normalized);
    if (!tId) continue;

    batch.push({
      sql: `INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id) VALUES (?, ?)`,
      args: [recId, tId],
    });
    if (batch.length >= BATCH_SIZE) await flushBatch();
  }
}

await flushBatch();
console.log("Recipe-tag koppelingen aangemaakt...");

// ─── Bonussen ────────────────────────────────────────────
for (const b of ahBonuses) {
  batch.push({
    sql: `INSERT INTO bonuses (product_name, discount_label, original_price, bonus_price, category, valid_from, valid_until, scraped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      b.productName,
      b.discountLabel,
      b.originalPrice ?? null,
      b.bonusPrice ?? null,
      b.category || "",
      b.validFrom ?? null,
      b.validUntil ?? null,
      b.scrapedAt,
    ],
  });
  if (batch.length >= BATCH_SIZE) await flushBatch();
}

await flushBatch();

// ─── Menu slots herstellen ──────────────────────────────
if (oldMenuSlots.rows.length > 0) {
  let restored = 0;
  for (const row of oldMenuSlots.rows) {
    const newRecipeId = urlToId.get(row.url as string);
    if (newRecipeId) {
      batch.push({
        sql: `INSERT INTO menu_slots (menu_week_id, day_of_week, recipe_id) VALUES (?, ?, ?)`,
        args: [row.menu_week_id as number, row.day_of_week as number, newRecipeId],
      });
      restored++;
      if (batch.length >= BATCH_SIZE) await flushBatch();
    }
  }
  await flushBatch();
  console.log(`Menu slots hersteld: ${restored}/${oldMenuSlots.rows.length}`);
}

// ─── Verificatie ─────────────────────────────────────────
const counts = await client.batch([
  "SELECT count(*) as n FROM recipes",
  "SELECT count(*) as n FROM recipes WHERE is_favorite = 1",
  "SELECT count(*) as n FROM recipes WHERE is_favorite = 0",
  "SELECT count(*) as n FROM ingredients",
  "SELECT count(*) as n FROM instructions",
  "SELECT count(*) as n FROM tags",
  "SELECT count(*) as n FROM recipe_tags",
  "SELECT count(*) as n FROM bonuses",
], "read");

console.log("");
console.log("=== Import Voltooid ===");
console.log(`Recepten:     ${counts[0]!.rows[0]!.n} (${counts[1]!.rows[0]!.n} fav, ${counts[2]!.rows[0]!.n} discover)`);
console.log(`Ingrediënten: ${counts[3]!.rows[0]!.n}`);
console.log(`Instructies:  ${counts[4]!.rows[0]!.n}`);
console.log(`Tags:         ${counts[5]!.rows[0]!.n}`);
console.log(`Recipe-tags:  ${counts[6]!.rows[0]!.n}`);
console.log(`Bonussen:     ${counts[7]!.rows[0]!.n}`);
