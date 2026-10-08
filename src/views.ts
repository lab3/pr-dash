import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { DashError, ROOT } from "./config.ts";
import { OWNER_RE, exactViewRepos, globToRegExp, isPattern, validateViews, viewOwners } from "../shared/views-core.ts";
import type { View } from "./types.ts";

export { OWNER_RE, exactViewRepos, globToRegExp, isPattern, validateViews, viewOwners };

export const VIEWS_PATH = process.env.PR_DASH_VIEWS ?? path.join(ROOT, "views.json");

export function loadViews(): View[] {
  if (!existsSync(VIEWS_PATH)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(VIEWS_PATH, "utf8"));
  } catch (e) {
    throw new DashError(`Could not read ${path.basename(VIEWS_PATH)}: ${(e as Error).message}`,
      "Fix or delete the file; views are saved there by the dashboard.", 500);
  }
  return validateViews(parsed);
}

export async function saveViews(views: View[]): Promise<void> {
  const tmp = `${VIEWS_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ views }, null, 2) + "\n", "utf8");
  await rename(tmp, VIEWS_PATH); // atomic replace
}
