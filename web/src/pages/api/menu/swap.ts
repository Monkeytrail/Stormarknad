import type { APIRoute } from "astro";
import { db } from "../../../db/client";
import { menuSlots, recipes } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";

export const POST: APIRoute = async ({ request, redirect }) => {
  const formData = await request.formData();
  const slotId = parseInt(formData.get("slotId") as string);

  if (isNaN(slotId)) return redirect("/menu", 302);

  // Haal huidige slot op
  const [slot] = await db.select().from(menuSlots).where(eq(menuSlots.id, slotId));
  if (!slot) return redirect("/menu", 302);

  // Haal alle recept IDs in het huidige menu
  const currentSlots = await db
    .select({ recipeId: menuSlots.recipeId })
    .from(menuSlots)
    .where(eq(menuSlots.menuWeekId, slot.menuWeekId));
  const usedIds = new Set(currentSlots.map((s) => s.recipeId));

  // Kies willekeurig een ander recept
  const allRecipes = await db.select({ id: recipes.id }).from(recipes);
  const available = allRecipes.filter((r) => !usedIds.has(r.id));

  if (available.length === 0) return redirect("/menu", 302);

  const randomRecipe = available[Math.floor(Math.random() * available.length)]!;

  await db
    .update(menuSlots)
    .set({ recipeId: randomRecipe.id })
    .where(eq(menuSlots.id, slotId));

  return redirect("/menu", 302);
};
