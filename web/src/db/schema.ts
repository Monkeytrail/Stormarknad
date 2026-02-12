import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ─── Recepten ────────────────────────────────────────────
export const recipes = sqliteTable("recipes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  imageUrl: text("image_url").notNull().default(""),
  servings: integer("servings").notNull().default(4),
  prepTime: integer("prep_time"),
  calories: integer("calories"),
  source: text("source").notNull(), // "ah.be" | "koken.demorgen"
  scrapedAt: text("scraped_at").notNull(),
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(true),
});

// ─── Ingrediënten (per recept) ───────────────────────────
export const ingredients = sqliteTable("ingredients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipeId: integer("recipe_id")
    .notNull()
    .references(() => recipes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: text("quantity").notNull().default(""),
  unit: text("unit").notNull().default(""),
  rawText: text("raw_text").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ─── Bereidingsstappen (per recept, geordend) ────────────
export const instructions = sqliteTable("instructions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipeId: integer("recipe_id")
    .notNull()
    .references(() => recipes.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull(),
  text: text("text").notNull(),
});

// ─── Tags ────────────────────────────────────────────────
export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
});

export const recipeTags = sqliteTable("recipe_tags", {
  recipeId: integer("recipe_id")
    .notNull()
    .references(() => recipes.id, { onDelete: "cascade" }),
  tagId: integer("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
});

// ─── Bonussen ────────────────────────────────────────────
export const bonuses = sqliteTable("bonuses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productName: text("product_name").notNull(),
  discountLabel: text("discount_label").notNull(),
  originalPrice: real("original_price"),
  bonusPrice: real("bonus_price"),
  category: text("category").notNull().default(""),
  validFrom: text("valid_from"),
  validUntil: text("valid_until"),
  scrapedAt: text("scraped_at").notNull(),
});

// ─── Weekmenu's ─────────────────────────────────────────
export const menuWeeks = sqliteTable("menu_weeks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weekStart: text("week_start").notNull(), // ISO datum "2026-02-09"
  createdAt: text("created_at").notNull(),
});

export const menuSlots = sqliteTable("menu_slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  menuWeekId: integer("menu_week_id")
    .notNull()
    .references(() => menuWeeks.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(), // 0=maandag ... 6=zondag
  recipeId: integer("recipe_id")
    .notNull()
    .references(() => recipes.id, { onDelete: "cascade" }),
});
