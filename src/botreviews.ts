// Pure logic for bot (PR Watcher) reviews: which actor is a bot, what counts as a nit,
// and how findings roll up into a status. No I/O, so `node --test` covers it.
import type { Finding, WatcherStatus } from "./types.ts";

/**
 * GraphQL reports bots with a bare login ("grok-pr-watcher") and `__typename: "Bot"`,
 * while config and the `reviews(author:)` filter use "grok-pr-watcher[bot]". Normalize
 * every actor to the "[bot]" form so the two can be compared.
 */
export function botLogin(author: { __typename?: string; login: string } | null | undefined): string | null {
  if (!author?.login) return null;
  const bare = author.login.replace(/\[bot\]$/i, "");
  const isBot = author.__typename === "Bot" || /\[bot\]$/i.test(author.login);
  return isBot ? `${bare}[bot]` : author.login;
}

/** A finding whose text starts with "Nit" (after any markdown decoration) is a nit. */
export function isNit(text: string): boolean {
  return /^[\s*_`#>\-]*nit(pick)?\b/i.test(text);
}

/** Status of one review from its findings. Nits are ignored; outdated threads are still open. */
export function reviewStatus(findings: Pick<Finding, "nit" | "resolved">[]): WatcherStatus {
  if (!findings.length) return "summary";
  const real = findings.filter((f) => !f.nit);
  const open = real.filter((f) => !f.resolved).length;
  if (open === 0) return "addressed";
  return open === real.length ? "open" : "partly";
}

const RANK: Record<WatcherStatus, number> = { summary: 0, addressed: 1, partly: 2, open: 3 };

/** A PR takes its latest review's status, but is at least "partly" if an older review still has open findings. */
export function overallStatus(latest: WatcherStatus, earlierOpen: number): WatcherStatus {
  return earlierOpen > 0 && RANK[latest] < RANK.partly ? "partly" : latest;
}
