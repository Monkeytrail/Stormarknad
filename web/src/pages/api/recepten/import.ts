import type { APIRoute } from "astro";

interface ParsedIngredient {
  name: string;
  quantity: string;
  unit: string;
  raw: string;
}

interface ParsedRecipe {
  title: string;
  url: string;
  imageUrl: string;
  servings: number;
  prepTime: number | null;
  source: string;
  ingredients: ParsedIngredient[];
  instructions: string[];
}

// ISO 8601 duration → minutes  e.g. "PT1H30M" → 90
function parseDuration(iso: string): number | null {
  if (!iso) return null;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return null;
  const hours = parseInt(match[1] ?? "0");
  const mins = parseInt(match[2] ?? "0");
  const total = hours * 60 + mins;
  return total > 0 ? total : null;
}

// Parse serving count from various formats: "4", "4 servings", ["4 porties"]
function parseServings(raw: unknown): number {
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw ?? "");
  const match = str.match(/\d+/);
  return match ? parseInt(match[0]) : 4;
}

// Extract image URL from string | string[] | ImageObject | ImageObject[]
function parseImage(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return parseImage(raw[0]);
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as any;
    return typeof obj.url === "string" ? obj.url : "";
  }
  return "";
}

// Parse instructions from HowToStep[] | HowToSection[] | string[]
function parseInstructions(raw: unknown): string[] {
  if (!raw || !Array.isArray(raw)) return [];
  const steps: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) steps.push(t);
    } else if (typeof item === "object" && item !== null) {
      const obj = item as any;
      if (obj["@type"] === "HowToSection" && Array.isArray(obj.itemListElement)) {
        steps.push(...parseInstructions(obj.itemListElement));
      } else if (typeof obj.text === "string") {
        const t = obj.text.trim();
        if (t) steps.push(t);
      }
    }
  }
  return steps;
}

// Simple ingredient string parser
// "300 g bloem" → {quantity:"300", unit:"g", name:"bloem"}
const UNITS = /^(kg|g|gr|gram|ml|l|dl|cl|el|eetlepel|eetlepels|tl|theelepel|theelepels|teen|teentje|teentjes|bos|stuk|stuks|snufje|takje|takjes|plak|plakje|plakjes|bol|bollen|blik|kopje|glas|handvol|mespunt|oz|cup|cups|lb|tsp|tbsp|pinch|bunch)\b/i;

function parseIngredient(raw: string): ParsedIngredient {
  const s = raw.trim();
  // Match leading number (including fractions like ½, ¼)
  const numMatch = s.match(/^([0-9½¼¾⅓⅔][0-9.,/\s½¼¾⅓⅔]*)\s*/);
  if (!numMatch) return { name: s, quantity: "", unit: "", raw: s };

  const quantity = numMatch[1].trim();
  const rest = s.slice(numMatch[0].length);

  const unitMatch = rest.match(UNITS);
  if (!unitMatch) return { name: rest.trim(), quantity, unit: "", raw: s };

  const unit = unitMatch[1];
  const name = rest.slice(unitMatch[0].length).trim();
  return { name: name || rest.trim(), quantity, unit, raw: s };
}

// Find Recipe JSON-LD in parsed objects (handles @graph)
function findRecipe(obj: any): any {
  if (!obj || typeof obj !== "object") return null;
  const types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
  if (types.includes("Recipe")) return obj;
  if (Array.isArray(obj["@graph"])) {
    for (const node of obj["@graph"]) {
      const found = findRecipe(node);
      if (found) return found;
    }
  }
  return null;
}

export const POST: APIRoute = async ({ request }) => {
  let url: string;
  try {
    const body = await request.json();
    url = body.url?.trim();
    if (!url) throw new Error("No URL");
    new URL(url); // validate
  } catch {
    return new Response(JSON.stringify({ error: "Ongeldige URL" }), { status: 400 });
  }

  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Stormarknad/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Kon pagina niet ophalen: ${err instanceof Error ? err.message : err}` }),
      { status: 502 }
    );
  }

  // Extract all JSON-LD blocks
  const jsonldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let recipeData: any = null;

  for (const block of jsonldBlocks) {
    try {
      const parsed = JSON.parse(block[1]!);
      // Handle top-level array
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        recipeData = findRecipe(item);
        if (recipeData) break;
      }
    } catch {
      // malformed JSON-LD, skip
    }
    if (recipeData) break;
  }

  if (!recipeData) {
    return new Response(
      JSON.stringify({ error: "Geen recept gevonden op deze pagina. Werkt alleen met sites die Schema.org/Recipe gebruiken." }),
      { status: 422 }
    );
  }

  const source = new URL(url).hostname.replace(/^www\./, "");

  const recipe: ParsedRecipe = {
    title: String(recipeData.name ?? "").trim(),
    url,
    imageUrl: parseImage(recipeData.image),
    servings: parseServings(recipeData.recipeYield),
    prepTime:
      parseDuration(recipeData.totalTime) ??
      parseDuration(recipeData.cookTime) ??
      parseDuration(recipeData.prepTime),
    source,
    ingredients: (recipeData.recipeIngredient ?? []).map((s: string) => parseIngredient(String(s))),
    instructions: parseInstructions(recipeData.recipeInstructions),
  };

  if (!recipe.title) {
    return new Response(JSON.stringify({ error: "Receptnaam niet gevonden" }), { status: 422 });
  }

  return new Response(JSON.stringify(recipe), {
    headers: { "Content-Type": "application/json" },
  });
};
