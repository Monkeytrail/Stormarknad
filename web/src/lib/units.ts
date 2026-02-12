const UNIT_MAP: Record<string, string> = {
  el: "eetlepel",
  "eetlepel(s)": "eetlepel",
  tl: "theelepel",
  "theelepel(s)": "theelepel",
  ml: "ml",
  l: "l",
  cl: "cl",
  dl: "dl",
  g: "g",
  kg: "kg",
  "stuk(s)": "stuk",
  stuks: "stuk",
  teen: "teentje",
  tenen: "teentje",
  "teentje(s)": "teentje",
  stengel: "stengel",
  stengels: "stengel",
  "stengel(s)": "stengel",
  "takje(s)": "takje",
  takjes: "takje",
  bosje: "bosje",
  "bosje(s)": "bosje",
  blikje: "blik",
  blikjes: "blik",
  blikken: "blik",
  blik: "blik",
  snufjes: "snufje",
  "snuifje(s)": "snufje",
  snufje: "snufje",
  plakje: "plakje",
  plakjes: "plakje",
  "plakje(s)": "plakje",
  zak: "zak",
  pak: "pak",
  bos: "bos",
  krop: "krop",
  kropjes: "krop",
  handvol: "handvol",
};

export function normalizeUnit(unit: string): string {
  const trimmed = unit.trim().toLowerCase();
  return UNIT_MAP[trimmed] ?? trimmed;
}

const FRACTIONS: Record<string, number> = {
  "\u00BD": 0.5, // ½
  "\u00BC": 0.25, // ¼
  "\u00BE": 0.75, // ¾
  "\u2153": 0.333, // ⅓
  "\u2154": 0.667, // ⅔
};

export function parseQuantity(q: string): number | null {
  if (!q || !q.trim()) return null;
  const cleaned = q.trim();

  // Pure fractie karakter
  if (FRACTIONS[cleaned] !== undefined) return FRACTIONS[cleaned]!;

  // Getal + fractie: "1½" -> 1.5
  for (const [char, val] of Object.entries(FRACTIONS)) {
    if (cleaned.includes(char)) {
      const prefix = cleaned.replace(char, "").trim();
      const base = prefix ? parseFloat(prefix.replace(",", ".")) : 0;
      return base + val;
    }
  }

  // Belgische decimale komma: "0,5" -> 0.5
  const num = parseFloat(cleaned.replace(",", "."));
  return isNaN(num) ? null : num;
}

export function normalizeIngredientName(name: string): string {
  let normalized = name.toLowerCase().trim();
  // Strip beschrijvingen na komma: "rode ui, gesneden" -> "rode ui"
  const commaIdx = normalized.indexOf(",");
  if (commaIdx > 0) {
    normalized = normalized.substring(0, commaIdx).trim();
  }
  return normalized;
}
