import type { APIRoute } from "astro";
import { db } from "../../../db/client";
import { recipes, ingredients, instructions } from "../../../db/schema";

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Ongeldig verzoek" }), { status: 400 });
  }

  const { title, url, imageUrl, servings, prepTime, source, ingredients: ings, instructions: steps } = body;

  if (!title || !url) {
    return new Response(JSON.stringify({ error: "Titel en URL zijn verplicht" }), { status: 400 });
  }

  // Check for duplicate URL
  const existing = await db.query.recipes.findFirst({ where: (r, { eq }) => eq(r.url, url) });
  if (existing) {
    return new Response(JSON.stringify({ id: existing.id, duplicate: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const [recipe] = await db
    .insert(recipes)
    .values({
      title: String(title).trim(),
      url: String(url),
      imageUrl: String(imageUrl ?? ""),
      servings: Number(servings) || 4,
      prepTime: prepTime ? Number(prepTime) : null,
      calories: null,
      source: String(source),
      scrapedAt: new Date().toISOString(),
      isFavorite: true,
    })
    .returning();

  if (Array.isArray(ings) && ings.length > 0) {
    await db.insert(ingredients).values(
      ings.map((ing: any, i: number) => ({
        recipeId: recipe!.id,
        name: String(ing.name ?? ""),
        quantity: String(ing.quantity ?? ""),
        unit: String(ing.unit ?? ""),
        rawText: String(ing.raw ?? ""),
        sortOrder: i,
      }))
    );
  }

  if (Array.isArray(steps) && steps.length > 0) {
    await db.insert(instructions).values(
      steps.map((text: string, i: number) => ({
        recipeId: recipe!.id,
        stepNumber: i + 1,
        text: String(text),
      }))
    );
  }

  return new Response(JSON.stringify({ id: recipe!.id }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};
