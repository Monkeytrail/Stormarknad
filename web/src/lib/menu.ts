import { db } from "../db/client";
import {
  recipes,
  ingredients,
  recipeTags,
  tags,
  bonuses,
  menuWeeks,
  menuSlots,
} from "../db/schema";
import { eq, desc, inArray } from "drizzle-orm";

export interface MenuSuggestion {
  dayOfWeek: number; // 0=maandag ... 6=zondag
  recipe: {
    id: number;
    title: string;
    imageUrl: string;
    prepTime: number | null;
    servings: number;
    source: string;
  };
  reason: string;
}

const DAY_NAMES = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
export { DAY_NAMES };

// ─── Cuisine tags voor diversiteit ────────────────────────
const CUISINE_TAGS = new Set([
  "aziatisch", "italiaans", "grieks", "mexicaans", "indiaas",
  "thais", "japans", "koreaans", "frans", "marokkaans",
  "midden-oosters", "amerikaans", "mediterraan",
]);

export async function generateWeekMenu(): Promise<MenuSuggestion[]> {
  // 1. Haal alle recepten op
  const allRecipes = await db.select().from(recipes);
  if (allRecipes.length < 7) {
    return allRecipes.slice(0, 7).map((r, i) => ({
      dayOfWeek: i,
      recipe: r,
      reason: "Favoriet",
    }));
  }

  // 2. Haal tags per recept op
  const allRecipeTags = await db
    .select({ recipeId: recipeTags.recipeId, tagName: tags.name })
    .from(recipeTags)
    .innerJoin(tags, eq(recipeTags.tagId, tags.id));

  const recipeTagMap = new Map<number, string[]>();
  for (const rt of allRecipeTags) {
    const existing = recipeTagMap.get(rt.recipeId) ?? [];
    existing.push(rt.tagName);
    recipeTagMap.set(rt.recipeId, existing);
  }

  // 3. Bouw smaakprofiel (tag-frequenties van favorieten)
  const tagFreq = new Map<string, number>();
  for (const r of allRecipes) {
    if (!r.isFavorite) continue;
    for (const t of recipeTagMap.get(r.id) ?? []) {
      tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
  }
  const maxTagFreq = Math.max(...tagFreq.values(), 1);

  // 4. Haal bonussen op
  const allBonuses = await db.select().from(bonuses);

  // 5. Haal ingrediënten per recept op
  const allIngredients = await db
    .select({ recipeId: ingredients.recipeId, name: ingredients.name })
    .from(ingredients);

  const recipeIngMap = new Map<number, string[]>();
  for (const ing of allIngredients) {
    const existing = recipeIngMap.get(ing.recipeId) ?? [];
    existing.push(ing.name.toLowerCase());
    recipeIngMap.set(ing.recipeId, existing);
  }

  // 6. Recente menu's ophalen (vorige 2 weken) voor freshness
  const recentMenus = await db
    .select()
    .from(menuWeeks)
    .orderBy(desc(menuWeeks.createdAt))
    .limit(2);

  const recentRecipeIds = new Set<number>();
  if (recentMenus.length > 0) {
    const menuIds = recentMenus.map((m) => m.id);
    const recentSlots = await db
      .select({ recipeId: menuSlots.recipeId })
      .from(menuSlots)
      .where(inArray(menuSlots.menuWeekId, menuIds));
    for (const s of recentSlots) {
      recentRecipeIds.add(s.recipeId);
    }
  }

  // 7. Score alle recepten
  const scored = allRecipes.map((r) => {
    const rTags = recipeTagMap.get(r.id) ?? [];
    const rIngs = recipeIngMap.get(r.id) ?? [];

    // Tag score (hoe goed past dit bij de smaak)
    let tagScore = 0;
    for (const t of rTags) {
      tagScore += tagFreq.get(t) ?? 0;
    }
    tagScore = rTags.length > 0 ? tagScore / rTags.length / maxTagFreq : 0;

    // Bonus score (woord-gebaseerde matching om false positives te voorkomen)
    let bonusMatches = 0;
    const matchedBonuses: string[] = [];
    for (const ing of rIngs) {
      const ingWords = ing.split(/[\s\-]+/).filter((w) => w.length >= 4);
      for (const b of allBonuses) {
        const productWords = b.productName.toLowerCase().split(/[\s\-]+/).filter((w) => w.length >= 4);
        const match = ingWords.some((iw) => productWords.some((pw) => pw === iw || pw.startsWith(iw) || iw.startsWith(pw)));
        if (match) {
          bonusMatches++;
          matchedBonuses.push(b.discountLabel);
          break;
        }
      }
    }
    const bonusScore = rIngs.length > 0 ? bonusMatches / rIngs.length : 0;

    // Freshness
    const freshness = recentRecipeIds.has(r.id) ? 0 : 0.1;

    // Random component
    const random = Math.random() * 0.1;

    const finalScore = tagScore * 0.5 + bonusScore * 0.3 + freshness + random;

    // Bepaal reden
    let reason = "Past bij je smaak";
    if (r.isFavorite) reason = "Favoriet";
    if (bonusMatches > 0) {
      reason = `Bonus: ${matchedBonuses[0]}`;
      if (r.isFavorite) reason = `Favoriet + ${reason}`;
    }

    // Cuisine tag voor diversiteitscheck
    const cuisine = rTags.find((t) => CUISINE_TAGS.has(t)) ?? null;

    return { recipe: r, finalScore, reason, cuisine, prepTime: r.prepTime ?? 30 };
  });

  // 8. Selecteer 7 recepten met diversiteit
  scored.sort((a, b) => b.finalScore - a.finalScore);

  const selected: (typeof scored)[number][] = [];
  const usedIds = new Set<number>();
  const cuisineCount = new Map<string, number>();

  function canSelect(item: (typeof scored)[number]): boolean {
    if (usedIds.has(item.recipe.id)) return false;
    if (recentRecipeIds.has(item.recipe.id)) return false;
    if (item.cuisine) {
      const count = cuisineCount.get(item.cuisine) ?? 0;
      if (count >= 2) return false;
    }
    return true;
  }

  // Selecteer mix: ~4 favorieten, ~3 suggesties
  const favorites = scored.filter((s) => s.recipe.isFavorite);
  const others = scored.filter((s) => !s.recipe.isFavorite);

  // Eerst favorieten
  for (const item of favorites) {
    if (selected.length >= 4) break;
    if (!canSelect(item)) continue;
    selected.push(item);
    usedIds.add(item.recipe.id);
    if (item.cuisine) cuisineCount.set(item.cuisine, (cuisineCount.get(item.cuisine) ?? 0) + 1);
  }

  // Dan suggesties (of meer favorieten als er niet genoeg anderen zijn)
  for (const item of [...others, ...favorites]) {
    if (selected.length >= 7) break;
    if (!canSelect(item)) continue;
    selected.push(item);
    usedIds.add(item.recipe.id);
    if (item.cuisine) cuisineCount.set(item.cuisine, (cuisineCount.get(item.cuisine) ?? 0) + 1);
  }

  // 9. Wijs dagen toe: langere recepten op weekend, snelle op weekdagen
  const weekdays = [0, 1, 2, 3, 4]; // ma-vr
  const weekend = [5, 6]; // za-zo
  const usedDays = new Set<number>();
  const result: MenuSuggestion[] = [];

  // Sorteer: langste bereidingstijd eerst zodat die weekend krijgen
  const toAssign = [...selected].sort((a, b) => b.prepTime - a.prepTime);

  for (const item of toAssign) {
    // Langere recepten (>30min) eerst op weekend, anders weekdagen
    // Snelle recepten (<= 30min) eerst op weekdagen, anders weekend
    let day: number | undefined;
    if (item.prepTime > 30) {
      day = weekend.find((d) => !usedDays.has(d)) ?? weekdays.find((d) => !usedDays.has(d));
    } else {
      day = weekdays.find((d) => !usedDays.has(d)) ?? weekend.find((d) => !usedDays.has(d));
    }

    if (day !== undefined) {
      result.push({ dayOfWeek: day, recipe: item.recipe, reason: item.reason });
      usedDays.add(day);
    }
  }

  result.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  return result;
}

export async function saveWeekMenu(suggestions: MenuSuggestion[]): Promise<number> {
  // Bepaal maandag van deze week
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().split("T")[0]!;

  const [menu] = await db
    .insert(menuWeeks)
    .values({ weekStart, createdAt: new Date().toISOString() })
    .returning();

  if (suggestions.length > 0) {
    await db.insert(menuSlots).values(
      suggestions.map((s) => ({
        menuWeekId: menu!.id,
        dayOfWeek: s.dayOfWeek,
        recipeId: s.recipe.id,
      }))
    );
  }

  return menu!.id;
}
