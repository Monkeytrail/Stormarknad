import type { APIRoute } from "astro";
import { db } from "../../../db/client";
import { menuSlots } from "../../../db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ request, redirect }) => {
  const formData = await request.formData();
  const slotId = parseInt(formData.get("slotId") as string);

  if (isNaN(slotId)) return redirect("/menu", 302);

  await db.delete(menuSlots).where(eq(menuSlots.id, slotId));

  return redirect("/menu", 302);
};
