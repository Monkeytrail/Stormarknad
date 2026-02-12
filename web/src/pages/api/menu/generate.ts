import type { APIRoute } from "astro";
import { generateWeekMenu, saveWeekMenu } from "../../../lib/menu";

export const POST: APIRoute = async ({ redirect }) => {
  const suggestions = await generateWeekMenu();
  await saveWeekMenu(suggestions);
  return redirect("/menu", 302);
};
