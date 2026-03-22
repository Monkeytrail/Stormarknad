export function sourceShort(source: string): { label: string; cssClass: string } {
  if (source === "ah.be") return { label: "AH", cssClass: "ah" };
  if (source === "koken.demorgen") return { label: "DM", cssClass: "dm" };
  if (source === "15gram.be") return { label: "15g", cssClass: "gram" };
  return { label: source, cssClass: "imp" };
}

export function sourceLong(source: string): string {
  if (source === "ah.be") return "Albert Heijn";
  if (source === "koken.demorgen") return "De Morgen";
  if (source === "15gram.be") return "15gram";
  return source;
}
