// UI state, view membership and filtering. Rendering lives in list.ts / grid.ts.
import type { DashboardData, PullRequest, Repo, View } from "../../src/types.ts";
import { store } from "./dom.ts";

export type SortKey = "count" | "updated" | "name";
export type Layout = "list" | "grid";
export type ToggleKey = "hideDrafts" | "onlyReview" | "onlyMine" | "showEmpty" | "onlyWatcher";

export const ALL_VIEW = "all";

export interface State {
  data: DashboardData | null;
  error: { message: string; hint?: string | null } | null;
  loading: boolean;
  views: View[];
  activeView: string;
  layout: Layout;
  filter: string;
  sort: SortKey;
  hideDrafts: boolean;
  onlyReview: boolean;
  onlyMine: boolean;
  showEmpty: boolean;
  onlyWatcher: boolean;   // only PRs with open Watcher findings
  owner: string; // "" = all owners (quick filter, applies within any view)
  collapsed: Set<string>;
  expanded: Set<string>;
  openPanels: Set<string>;     // PR urls whose Watcher panel is open (not persisted)
  expandedBodies: Set<string>; // review ids whose summary is fully shown (not persisted)
  timer: number | undefined;
}

export const state: State = {
  data: null,
  error: null,
  loading: false,
  views: [],
  activeView: store.get("activeView", ALL_VIEW),
  layout: store.get<Layout>("layout", "list"),
  filter: "",
  sort: store.get<SortKey>("sort", "count"),
  hideDrafts: store.get("hideDrafts", false),
  onlyReview: store.get("onlyReview", false),
  onlyMine: store.get("onlyMine", false),
  showEmpty: store.get("showEmpty", false),
  owner: store.get("owner", ""),
  collapsed: new Set(store.get<string[]>("collapsed", [])),
  onlyWatcher: store.get("onlyWatcher", false),
  expanded: new Set(),
  openPanels: new Set(),
  expandedBodies: new Set(),
  timer: undefined,
};

/** Set by app.ts so render modules can ask for a re-render without importing app.ts. */
export const hooks = { render: (): void => {} };

// ------------------------------------------------------------------ views

export const isPattern = (entry: string): boolean => /[*?]/.test(entry);

function globToRegExp(glob: string): RegExp {
  const body = glob.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

export const ownerOf = (repoName: string): string => repoName.split("/")[0];

/** Does a repo belong to a view? (any listed owner, exact repo, or pattern) */
export function viewMatcher(view: Pick<View, "owners" | "repos">): (repoName: string) => boolean {
  const owners = new Set(view.owners.map((o) => o.toLowerCase()));
  const exact = new Set(view.repos.filter((r) => !isPattern(r)).map((r) => r.toLowerCase()));
  const globs = view.repos.filter(isPattern).map(globToRegExp);
  return (name) => {
    const n = name.toLowerCase();
    return owners.has(ownerOf(n)) || exact.has(n) || globs.some((re) => re.test(n));
  };
}

/** Owners present in a set of repos, with repo and open-PR counts, most PRs first. */
export function ownersIn(repos: Repo[]): { owner: string; repos: number; prs: number }[] {
  const by = new Map<string, { owner: string; repos: number; prs: number }>();
  for (const r of repos) {
    const o = ownerOf(r.name);
    const e = by.get(o.toLowerCase()) ?? { owner: o, repos: 0, prs: 0 };
    e.repos++;
    e.prs += r.openCount;
    by.set(o.toLowerCase(), e);
  }
  return [...by.values()].sort((a, b) => b.prs - a.prs || a.owner.localeCompare(b.owner));
}

export function activeView(): View | null {
  return state.views.find((v) => v.id === state.activeView) ?? null;
}

/** Repos in a view (all repos for the built-in "All repos" view). */
export function reposIn(data: DashboardData, view: View | null): Repo[] {
  if (!view) return data.repos;
  const match = viewMatcher(view);
  return data.repos.filter((r) => match(r.name));
}

/** Exact entries in a view that GitHub didn't return (typo, no access, or not fetched yet). */
export function missingIn(data: DashboardData, view: View | null): string[] {
  if (!view) return [];
  const have = new Set(data.repos.map((r) => r.name.toLowerCase()));
  return view.repos.filter((r) => !isPattern(r) && !have.has(r.toLowerCase()));
}

/** Owners in a view that returned no repos at all. */
export function missingOwnersIn(data: DashboardData, view: View | null): string[] {
  if (!view) return [];
  const have = new Set(data.repos.map((r) => ownerOf(r.name).toLowerCase()));
  return view.owners.filter((o) => !have.has(o.toLowerCase()));
}

// ------------------------------------------------------------------ filtering

export interface RepoView {
  repo: Repo;
  prs: PullRequest[];
}

export interface Computed {
  scoped: boolean;        // a saved view (not "All repos") is active
  repos: Repo[];          // repos in the active view
  withPrs: RepoView[];    // repos with at least one visible PR, sorted
  empty: Repo[];          // repos with no open PRs that should be listed
  missing: string[];
  missingOwners: string[];
  owners: { owner: string; repos: number; prs: number }[]; // owners in the view, for the owner filter
  ownerActive: boolean;   // owner quick filter applies to this view
  prFilterOn: boolean;
  botReviews: boolean;    // bot_reviews is on, so Watcher chrome should show
}

/**
 * `watcher:<value>` search tokens. "open" = has open findings, "none" = no Watcher review,
 * otherwise the PR's overall status ("addressed", "partly", "summary").
 */
export function watcherMatch(pr: PullRequest, value: string): boolean {
  const w = pr.watcher;
  switch (value) {
    case "open": return !!w && w.open > 0;
    case "none": return !w;
    case "addressed": case "partly": case "summary": return w?.status === value;
    default: return true; // unknown value: don't filter anything out
  }
}

function prVisible(pr: PullRequest, repo: Repo, terms: string[]): boolean {
  if (state.hideDrafts && pr.isDraft) return false;
  if (state.onlyReview && !pr.reviewRequestedFromMe) return false;
  if (state.onlyMine && !pr.isMine) return false;
  if (state.onlyWatcher && !(pr.watcher && pr.watcher.open > 0)) return false;
  if (!terms.length) return true;
  const hay = [repo.name, pr.title, "#" + pr.number, pr.author, pr.head ?? "", pr.base ?? "",
    ...pr.labels.map((l) => l.name)].join(" ").toLowerCase();
  return terms.every((t) => (t.startsWith("watcher:") ? watcherMatch(pr, t.slice("watcher:".length)) : hay.includes(t)));
}

export function compute(data: DashboardData): Computed {
  const view = activeView();
  const scoped = !!view;
  const q = state.filter.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const inView = reposIn(data, view);
  const owners = ownersIn(inView);
  // The owner quick filter only applies if that owner has repos in this view.
  const ownerActive = !!state.owner && owners.some((o) => o.owner.toLowerCase() === state.owner.toLowerCase());
  const repos = ownerActive ? inView.filter((r) => ownerOf(r.name).toLowerCase() === state.owner.toLowerCase()) : inView;
  const prFilterOn = !!q || state.hideDrafts || state.onlyReview || state.onlyMine || state.onlyWatcher;
  const withPrs: RepoView[] = [];
  const empty: Repo[] = [];
  // Repos named one by one in a saved view always show, even with no PRs. Repos that
  // come in via an owner or pattern follow the "Show repos with no PRs" toggle, so a big
  // org doesn't flood the page with empty cards.
  const named = new Set((view?.repos ?? []).filter((r) => !isPattern(r)).map((r) => r.toLowerCase()));
  for (const repo of repos) {
    const prs = repo.prs.filter((pr) => prVisible(pr, repo, terms));
    if (prs.length) withPrs.push({ repo, prs });
    else if (repo.openCount === 0 && (state.showEmpty || named.has(repo.name.toLowerCase()))
      && (!q || repo.name.toLowerCase().includes(q))) empty.push(repo);
  }
  const latest = (x: RepoView) => Math.max(...x.prs.map((p) => +new Date(p.updatedAt)));
  const sorters: Record<SortKey, (a: RepoView, b: RepoView) => number> = {
    count: (a, b) => b.prs.length - a.prs.length || latest(b) - latest(a),
    updated: (a, b) => latest(b) - latest(a),
    name: (a, b) => a.repo.name.localeCompare(b.repo.name),
  };
  withPrs.sort(sorters[state.sort] ?? sorters.count);
  empty.sort((a, b) => a.name.localeCompare(b.name));
  return {
    scoped, repos, withPrs, empty, owners, ownerActive, prFilterOn, botReviews: data.botReviews,
    missing: missingIn(data, view),
    missingOwners: missingOwnersIn(data, view),
  };
}
