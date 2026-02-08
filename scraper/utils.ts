import { type Page } from "playwright";
import { mkdir } from "fs/promises";
import { join } from "path";

const SCREENSHOTS_DIR = join(import.meta.dir, "..", "screenshots");

await mkdir(SCREENSHOTS_DIR, { recursive: true });

export async function screenshot(page: Page, name: string) {
  const path = join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`📸 Screenshot: ${path}`);
}

export async function waitAndClick(page: Page, selector: string) {
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.click(selector);
}

export function log(context: string, message: string) {
  const time = new Date().toLocaleTimeString("nl-BE");
  console.log(`[${time}] [${context}] ${message}`);
}
