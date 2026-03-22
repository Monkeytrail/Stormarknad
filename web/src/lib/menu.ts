import { db } from "../db/client";
import { recipes, ingredients, bonuses, menuWeeks, menuSlots } from "../db/schema";
import { desc, inArray } from "drizzle-orm";

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

export const DAY_NAMES = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];

export async function generateWeekMenu(): Promise<MenuSuggestion[]> {
  const allRecipes = await db.select().from(recipes);
  const favorites = allRecipes.filter((r) => r.isFavorite);
  if (favorites.length === 0) return [];

  // Exclude recipes used in the last 2 weeks
  const recentMenus = await db.select().from(menuWeeks).orderBy(desc(menuWeeks.createdAt)).limit(2);
  const recentIds = new Set<number>();
  if (recentMenus.length > 0) {
    const recentSlots = await db
      .select({ recipeId: menuSlots.recipeId })
      .from(menuSlots)
      .where(inArray(menuSlots.menuWeekId, recentMenus.map((m) => m.id)));
    for (const s of recentSlots) recentIds.add(s.recipeId);
  }

  let pool = favorites.filter((r) => !recentIds.has(r.id));
  if (pool.length < 7) pool = favorites; // fall back if pool is too small

  // Find which pool recipes have bonus-matching ingredients
  const allBonuses = await db.select({ productName: bonuses.productName }).from(bonuses);
  const bonusWords = new Set(
    allBonuses.flatMap((b) => b.productName.toLowerCase().split(/[\s-]+/).filter((w) => w.length >= 4))
  );

  const poolIngredients = pool.length > 0
    ? await db
        .select({ recipeId: ingredients.recipeId, name: ingredients.name })
        .from(ingredients)
        .where(inArray(ingredients.recipeId, pool.map((r) => r.id)))
    : [];

  const ingMap = new Map<number, string[]>();
  for (const ing of poolIngredients) {
    const arr = ingMap.get(ing.recipeId) ?? [];
    arr.push(ing.name.toLowerCase());
    ingMap.set(ing.recipeId, arr);
  }

  function hasBonus(id: number): boolean {
    return (ingMap.get(id) ?? []).some((name) =>
      name.split(/[\s-]+/).some((w) => w.length >= 4 && bonusWords.has(w))
    );
  }

  // Shuffle randomly, then bring bonus recipes to the front
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  shuffled.sort((a, b) => Number(hasBonus(b.id)) - Number(hasBonus(a.id)));

  // Take 7, assign longer-prep recipes to weekend slots
  const selected = shuffled.slice(0, 7).sort((a, b) => (b.prepTime ?? 30) - (a.prepTime ?? 30));
  const days = [5, 6, 0, 1, 2, 3, 4]; // longest prep → zaterdag/zondag first

  return selected
    .map((recipe, i) => ({
      dayOfWeek: days[i]!,
      recipe,
      reason: hasBonus(recipe.id) ? "Bonus" : "Favoriet",
    }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

export async function saveWeekMenu(suggestions: MenuSuggestion[]): Promise<number> {
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
