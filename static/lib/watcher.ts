// Watcher (bot review) chrome shared by the list and grid layouts: status badges, the
// mergeable indicator, the grid status dot, and the collapsible review panel.
import type { Finding, PullRequest, WatcherReview, WatcherStatus } from "../../src/types.ts";
import { ago, h, html, link } from "./dom.ts";
import { hooks, state } from "./state.ts";

export const STATUS_LABEL: Record<WatcherStatus, string> = {
  open: "open",
  partly: "partly addressed",
  addressed: "addressed",
  summary: "summary only",
};

/** A review body with more blocks than this is clamped until "Show more" is clicked. */
const CLAMP_BLOCKS = 8;

const countLabel = (open: number, total: number, status: WatcherStatus): string =>
  open ? `${open}/${total} open` : STATUS_LABEL[status];

/** Status badge, nits badge and "new commits" chip for a PR row. Empty without a Watcher review. */
export function watcherBadges(pr: PullRequest): HTMLElement[] {
  const w = pr.watcher;
  if (!w) return [];
  const out = [h("span", { class: `badge w-${w.status}`, title: `Watcher: ${STATUS_LABEL[w.status]}` },
    "Watcher: ", countLabel(w.open, w.total, w.status))];
  if (w.nits) out.push(h("span", { class: "badge nits", title: "Nits never count toward open findings" },
    `${w.nits} nit${w.nits === 1 ? "" : "s"}`));
  if (w.stale) out.push(h("span", { class: "badge stale", title: "The PR has new commits since the latest Watcher review" },
    "new commits"));
  return out;
}

/** Small colored dot for the grid layout. */
export function watcherDot(pr: PullRequest): HTMLElement | null {
  const w = pr.watcher;
  if (!w) return null;
  return h("span", { class: `wdot ${w.status}`, title: `Watcher: ${countLabel(w.open, w.total, w.status)}` });
}

/** Green "Ready to merge", or gray with what's blocking. Shown for every PR. */
export function mergeIndicator(pr: PullRequest): HTMLElement {
  const ready = pr.blockers.length === 0;
  return h("span", {
    class: "merge " + (ready ? "ready" : "blocked"),
    title: ready ? "Watcher clear, mergeable, CI passing, not a draft, no changes requested" : "Blocking: " + pr.blockers.join(", "),
  }, h("span", { class: "dot" }), ready ? "Ready to merge" : pr.blockers.join(" · "));
}

/** Collapsible panel under a list row: latest review, then earlier ones. Closed by default. */
export function watcherPanel(pr: PullRequest): HTMLElement | null {
  const w = pr.watcher;
  if (!w) return null;
  const key = pr.url;
  const earlierKey = key + "#earlier";
  return h("details", {
    class: "wpanel",
    open: state.openPanels.has(key),
    ontoggle: (e: Event) => {
      if ((e.currentTarget as HTMLDetailsElement).open) state.openPanels.add(key);
      else state.openPanels.delete(key);
    },
  },
    h("summary", null, "Watcher review", h("span", { class: "muted" }, ` · ${ago(w.latest.submittedAt)}`),
      w.earlier.length ? h("span", { class: "muted" }, ` · ${w.earlier.length} earlier`) : null),
    reviewBlock(w.latest),
    w.earlier.length
      ? h("details", {
        class: "wearlier",
        open: state.openPanels.has(earlierKey),
        ontoggle: (e: Event) => {
          if ((e.currentTarget as HTMLDetailsElement).open) state.openPanels.add(earlierKey);
          else state.openPanels.delete(earlierKey);
        },
      },
        h("summary", null, `Earlier reviews (${w.earlier.length})`),
        w.earlier.map(reviewBlock))
      : null,
  );
}

const blockCount = (markup: string): number => (markup.match(/<(p|li|h3|h4|pre|tr|blockquote)>/g) ?? []).length;

function reviewBlock(r: WatcherReview): HTMLElement {
  const long = blockCount(r.html) > CLAMP_BLOCKS;
  const expanded = state.expandedBodies.has(r.id);
  return h("div", { class: "wreview" },
    h("div", { class: "wreview-head" },
      h("span", { class: `badge w-${r.status}` }, countLabel(r.open, r.total, r.status)),
      r.nits ? h("span", { class: "badge nits" }, `${r.nits} nit${r.nits === 1 ? "" : "s"}`) : null,
      r.stale ? h("span", { class: "badge stale" }, "new commits since") : null,
      h("span", { class: "muted", title: new Date(r.submittedAt).toLocaleString() }, ago(r.submittedAt)),
      link(r.url, { class: "muted" }, "view on GitHub ↗"),
    ),
    html("md" + (long && !expanded ? " clamped" : ""), r.html),
    long ? h("button", {
      type: "button", class: "linkish",
      onclick: () => {
        if (expanded) state.expandedBodies.delete(r.id);
        else state.expandedBodies.add(r.id);
        hooks.render();
      },
    }, expanded ? "Show less" : "Show more") : null,
    r.findings.length
      ? h("ul", { class: "findings" }, r.findings.map(findingRow))
      : h("div", { class: "muted fnone" }, "No inline findings."),
  );
}

function findingRow(f: Finding): HTMLElement {
  const [cls, mark, label] = f.resolved
    ? ["resolved", "✓", "resolved"]
    : f.outdated ? ["outdated", "↻", "open; the code changed since"] : ["open", "●", "open"];
  return h("li", { class: "finding f-" + cls },
    h("span", { class: "fmark", title: label, "aria-label": label }, mark),
    link(f.url, { class: "floc" }, f.path + (f.line === null ? "" : ":" + f.line)),
    f.nit ? h("span", { class: "badge nits" }, "nit") : null,
    html("ftext md", f.html),
    f.replies ? h("span", { class: "muted freplies" }, `${f.replies} repl${f.replies === 1 ? "y" : "ies"}`) : null,
  );
}
