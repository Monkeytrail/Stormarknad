import { normalizeUnit, parseQuantity, normalizeIngredientName } from "./units";

interface IngredientInput {
  name: string;
  quantity: string;
  unit: string;
  recipeName: string;
}

export interface ShoppingItem {
  name: string;
  displayName: string;
  totalQuantity: string;
  unit: string;
  category: string;
  fromRecipes: string[];
}

// Categorie trefwoorden
const CATEGORIES: [string, string[]][] = [
  ["groenten", ["ui", "paprika", "tomaat", "wortel", "aardappel", "sla", "spinazie", "broccoli", "courgette", "aubergine", "bloemkool", "prei", "komkommer", "venkel", "champignon", "radijs", "knolselderij", "biet", "mais", "avocado", "bonen"]],
  ["fruit", ["appel", "citroen", "limoen", "sinaasappel", "banaan", "mango", "ananas"]],
  ["zuivel", ["melk", "kaas", "yoghurt", "room", "boter", "crème", "mascarpone", "ricotta", "mozzarella", "parmezaan", "feta", "ei"]],
  ["vlees", ["kip", "gehakt", "varken", "rund", "spek", "ham", "worst", "lam", "steak", "filet"]],
  ["vis", ["zalm", "kabeljauw", "garnaal", "tonijn", "vis", "scampi", "pangasius"]],
  ["droog", ["rijst", "pasta", "couscous", "noedel", "spaghetti", "penne", "mie", "bulgur", "quinoa", "linzen", "bloem", "suiker", "brood"]],
  ["kruiden", ["peper", "zout", "komijn", "paprikapoeder", "kurkuma", "kaneel", "nootmuskaat", "oregano", "basilicum", "tijm", "rozemarijn", "dille", "peterselie", "koriander", "bieslook"]],
  ["sauzen", ["sojasaus", "olijfolie", "olie", "azijn", "ketjap", "sriracha", "tabasco", "mosterd", "mayonaise", "pesto", "tomatenpuree", "passata", "sambal", "hoisin", "gochujang"]],
];

function categorize(name: string): string {
  const lower = name.toLowerCase();
  for (const [category, keywords] of CATEGORIES) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) return category;
    }
  }
  return "overig";
}

export function aggregateShoppingList(ingredientInputs: IngredientInput[]): ShoppingItem[] {
  // Groepeer op genormaliseerde (naam, eenheid)
  const groups = new Map<string, {
    displayName: string;
    quantities: number[];
    unit: string;
    category: string;
    recipes: Set<string>;
    hasUnparseableQty: boolean;
  }>();

  for (const ing of ingredientInputs) {
    const normalized = normalizeIngredientName(ing.name);
    const unit = normalizeUnit(ing.unit);
    const key = `${normalized}||${unit}`;

    if (!groups.has(key)) {
      groups.set(key, {
        displayName: ing.name, // Bewaar originele naam voor display
        quantities: [],
        unit,
        category: categorize(normalized),
        recipes: new Set(),
        hasUnparseableQty: false,
      });
    }

    const group = groups.get(key)!;
    group.recipes.add(ing.recipeName);

    const qty = parseQuantity(ing.quantity);
    if (qty !== null) {
      group.quantities.push(qty);
    } else if (ing.quantity) {
      group.hasUnparseableQty = true;
    }
  }

  // Converteer naar output
  const items: ShoppingItem[] = [];
  for (const group of groups.values()) {
    const total = group.quantities.reduce((sum, q) => sum + q, 0);
    let totalQuantity = "";

    if (group.quantities.length > 0) {
      // Rond af op 1 decimaal, toon als geheel getal als mogelijk
      totalQuantity = total % 1 === 0 ? String(total) : total.toFixed(1);
    }

    items.push({
      name: normalizeIngredientName(group.displayName),
      displayName: group.displayName,
      totalQuantity,
      unit: group.unit,
      category: group.category,
      fromRecipes: [...group.recipes],
    });
  }

  // Sorteer op categorie, dan naam
  const categoryOrder = CATEGORIES.map(([c]) => c);
  categoryOrder.push("overig");

  items.sort((a, b) => {
    const catA = categoryOrder.indexOf(a.category);
    const catB = categoryOrder.indexOf(b.category);
    if (catA !== catB) return catA - catB;
    return a.name.localeCompare(b.name, "nl");
  });

  return items;
}
