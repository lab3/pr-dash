// Entry point for the browser UI. The server strips types from every .ts file it
// serves, so these modules load as plain JavaScript (no build step). Only erasable
// TypeScript syntax is allowed: no enums, namespaces or parameter properties.
import type { ApiError, DashboardData, View, ViewsPayload } from "../src/types.ts";
import { ICON, ago, h, store, svg } from "./lib/dom.ts";
import { openViewEditor } from "./lib/editor.ts";
import { renderGrid } from "./lib/grid.ts";
import { renderEmptyList, renderList } from "./lib/list.ts";
import {
  ALL_VIEW, activeView, compute, hooks, reposIn, state,
  type Computed, type Layout, type SortKey, type ToggleKey,
} from "./lib/state.ts";

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

const els = {
  viewer: byId("viewer"),
  tabs: byId("tabs"),
  filter: byId<HTMLInputElement>("filter"),
  sort: byId<HTMLSelectElement>("sort"),
  layout: byId("layout"),
  refresh: byId<HTMLButtonElement>("refresh"),
  summary: byId("summary"),
  notice: byId("notice"),
  repos: byId("repos"),
  empty: byId("empty-repos"),
  footer: byId("footer"),
  drafts: byId<HTMLInputElement>("t-drafts"),
  review: byId<HTMLInputElement>("t-review"),
  mine: byId<HTMLInputElement>("t-mine"),
  showEmpty: byId<HTMLInputElement>("t-empty"),
  owner: byId<HTMLSelectElement>("owner"),
  watcher: byId<HTMLInputElement>("t-watcher"),
  watcherLabel: byId("t-watcher-label"),
};

// ------------------------------------------------------------------ API

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({ error: "Server returned an unreadable response." }))) as T | ApiError;
  if (!res.ok || (body && typeof body === "object" && "error" in body)) {
    const err = body as ApiError;
    throw Object.assign(new Error(err.error || res.statusText), { hint: err.hint });
  }
  return body as T;
}

async function load(force: boolean): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  els.refresh.classList.add("loading");
  if (!state.data) els.repos.replaceChildren(...[1, 2, 3].map(() => h("div", { class: "skeleton" })));
  try {
    const data = await api<DashboardData>("/api/prs" + (force ? "?refresh=1" : ""));
    state.data = data;
    state.error = null;
    scheduleRefresh(data.refreshSeconds);
  } catch (err) {
    const e = err as Error & { hint?: string | null };
    state.error = { message: e.message || String(e), hint: e instanceof TypeError ? "Is the server still running?" : e.hint };
  } finally {
    state.loading = false;
    els.refresh.classList.remove("loading");
    render();
  }
}

async function loadViews(): Promise<void> {
  try {
    state.views = (await api<ViewsPayload>("/api/views")).views;
  } catch (err) {
    state.error = { message: "Couldn't load saved views: " + (err as Error).message };
  }
  if (state.activeView !== ALL_VIEW && !activeView()) setActiveView(ALL_VIEW, false);
}

async function saveViews(views: View[]): Promise<void> {
  const res = await api<ViewsPayload>("/api/views", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-PR-Dash": "1" },
    body: JSON.stringify({ views }),
  });
  state.views = res.views;
  // If the views named a repo or owner the server hasn't fetched, it marked its cache stale,
  // so this picks up the new repos; otherwise it's answered from cache.
  void load(false);
}

function scheduleRefresh(seconds: number): void {
  clearInterval(state.timer);
  if (seconds > 0) state.timer = window.setInterval(() => { if (!document.hidden) void load(false); }, seconds * 1000);
}

// ------------------------------------------------------------------ views

function viewFromHash(): string | null {
  const m = /(?:^|[#&])view=([a-z0-9-]+)/.exec(location.hash);
  return m ? m[1] : null;
}

function setActiveView(id: string, rerender = true): void {
  state.activeView = id;
  state.expanded.clear();
  store.set("activeView", id);
  const hash = id === ALL_VIEW ? "" : `#view=${id}`;
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
  if (rerender) render();
}

function editView(view: View | null): void {
  openViewEditor({
    view,
    repos: state.data?.repos ?? [],
    onSave: async (saved) => {
      const exists = state.views.some((v) => v.id === saved.id);
      await saveViews(exists ? state.views.map((v) => (v.id === saved.id ? saved : v)) : [...state.views, saved]);
      setActiveView(saved.id);
    },
    onDelete: async (id) => {
      await saveViews(state.views.filter((v) => v.id !== id));
      setActiveView(ALL_VIEW);
    },
  });
}

// ------------------------------------------------------------------ rendering

hooks.render = render;

function render(): void {
  renderTabs();
  els.layout.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.layout === state.layout));
  });
  const data = state.data;
  if (!data) {
    renderNotice(null);
    if (state.error) els.repos.replaceChildren();
    return;
  }
  const c = compute(data);
  els.viewer.textContent = data.viewer ? "@" + data.viewer : "";
  renderOwnerFilter(c);
  els.watcherLabel.hidden = !c.botReviews;
  renderNotice(c);
  renderSummary(c);
  renderContent(c);
  renderFooter();
}

function renderTabs(): void {
  const data = state.data;
  const count = (v: View | null) => (data ? reposIn(data, v).reduce((n, r) => n + r.openCount, 0) : null);
  const tab = (id: string, label: string, view: View | null, n: number) => {
    const active = state.activeView === id;
    const c = count(view);
    return h("div", { class: "tab" + (active ? " active" : "") },
      h("button", {
        type: "button", class: "tab-btn", role: "tab", "aria-selected": String(active),
        title: n <= 9 ? `${label} (${n})` : label,
        onclick: () => setActiveView(id),
      }, label, c === null ? null : h("span", { class: "tab-count" }, c)),
      view && active ? h("button", {
        type: "button", class: "tab-edit", title: `Edit "${label}"`, "aria-label": `Edit view ${label}`,
        onclick: () => editView(view),
      }, svg(ICON.pencil, 12)) : null);
  };
  els.tabs.replaceChildren(
    tab(ALL_VIEW, "All repos", null, 1),
    ...state.views.map((v, i) => tab(v.id, v.name, v, i + 2)),
    h("button", { type: "button", class: "tab-new", onclick: () => editView(null), disabled: !state.data },
      svg(ICON.plus, 12), "New view"),
  );
}

function renderNotice(c: Computed | null): void {
  const parts: HTMLElement[] = [];
  if (state.error) {
    parts.push(h("div", { class: "notice error" },
      h("strong", null, "Couldn't load pull requests. "), state.error.message,
      state.error.hint ? h("div", { class: "muted", style: "margin-top:6px" }, state.error.hint) : null,
      state.data ? h("div", { class: "muted", style: "margin-top:6px" }, "Showing the last data that loaded.") : null));
  }
  if (c?.missingOwners.length) {
    parts.push(h("div", { class: "notice warn" },
      `No repos found for: ${c.missingOwners.join(", ")}. `,
      h("span", { class: "muted" }, "Check the spelling, or that your token can see their repos.")));
  }
  if (c?.missing.length) {
    parts.push(h("div", { class: "notice warn" },
      `Not found or no access: ${c.missing.join(", ")}. `,
      h("span", { class: "muted" }, "Check the spelling, or that your token can see them.")));
  }
  const warns = state.data?.warnings ?? [];
  if (warns.length) {
    parts.push(h("details", { class: "notice warn" },
      h("summary", null, `${warns.length} warning${warns.length > 1 ? "s" : ""} from GitHub`),
      h("ul", null, warns.map((w) => h("li", null, w)))));
  }
  els.notice.replaceChildren(...parts);
}

function renderOwnerFilter(c: Computed): void {
  const opts = [h("option", { value: "" }, `All owners (${c.owners.length})`),
    ...c.owners.map((o) => h("option", { value: o.owner }, `${o.owner} · ${o.prs} PR${o.prs === 1 ? "" : "s"}`))];
  els.owner.replaceChildren(...opts);
  els.owner.value = c.ownerActive ? (c.owners.find((o) => o.owner.toLowerCase() === state.owner.toLowerCase())?.owner ?? "") : "";
  els.owner.classList.toggle("active", c.ownerActive);
  // Only worth showing when there's more than one owner to choose from.
  els.owner.hidden = c.owners.length < 2 && !c.ownerActive;
}

function stat(n: number, label: string, cls = ""): HTMLElement {
  return h("span", { class: "stat" + (cls ? " " + cls : "") }, h("b", null, n), label);
}

function renderSummary(c: Computed): void {
  const prs = c.repos.flatMap((r) => r.prs);
  const total = c.repos.reduce((n, r) => n + r.openCount, 0);
  const shown = c.withPrs.reduce((n, x) => n + x.prs.length, 0);
  const review = prs.filter((p) => p.reviewRequestedFromMe).length;
  const chips = [
    stat(total, total === 1 ? "open PR" : "open PRs"),
    stat(c.repos.filter((r) => r.openCount > 0).length, `of ${c.repos.length} repos`),
    stat(review, "need your review", review ? "attn" : ""),
    stat(prs.filter((p) => p.isMine).length, "yours"),
    stat(prs.filter((p) => p.isDraft).length, "drafts"),
  ];
  if (c.botReviews) {
    const open = prs.reduce((n, p) => n + (p.watcher?.open ?? 0), 0);
    chips.push(stat(open, "open Watcher findings", open ? "attn" : ""));
  }
  if (c.prFilterOn) chips.push(stat(shown, "match filters", "attn"));
  if (c.ownerActive) {
    chips.push(h("button", {
      type: "button", class: "stat clear", title: "Clear owner filter",
      onclick: () => setOwner(""),
    }, "owner: ", h("b", null, state.owner), svg(ICON.x, 11)));
  }
  els.summary.replaceChildren(...chips);
}

function renderContent(c: Computed): void {
  if (!c.withPrs.length && !c.empty.length) {
    const msg = c.prFilterOn ? "No pull requests match your filters."
      : c.scoped && !c.repos.length ? "No repos in this view yet. Use the pencil on the tab to add some."
      : "No open pull requests. Nice.";
    els.repos.replaceChildren(h("div", { class: "placeholder" }, msg));
    els.empty.replaceChildren();
    return;
  }
  if (state.layout === "grid") {
    els.repos.replaceChildren(renderGrid(c.withPrs, c.empty));
    els.empty.replaceChildren();
  } else {
    els.repos.replaceChildren(...renderList(c.withPrs));
    if (!c.withPrs.length) els.repos.replaceChildren(h("div", { class: "placeholder" }, c.prFilterOn ? "No pull requests match your filters." : "No open pull requests. Nice."));
    const emptyList = renderEmptyList(c.empty, true);
    els.empty.replaceChildren(...(emptyList ? [emptyList] : []));
  }
}

function renderFooter(): void {
  const d = state.data;
  if (!d) return;
  const parts = [`Updated ${ago(d.generatedAt)} · fetched in ${(d.fetchMs / 1000).toFixed(1)}s`];
  if (d.refreshSeconds) parts.push(`auto-refresh every ${Math.max(1, Math.round(d.refreshSeconds / 60))} min`);
  if (d.rateLimit) parts.push(`API ${d.rateLimit.remaining}/${d.rateLimit.limit} left`);
  const ageMs = Date.now() - +new Date(d.generatedAt);
  if (d.hosted && ageMs > 10 * 60_000) parts.push("no fresh data for 10+ min");
  els.footer.textContent = parts.join(" · ");
}

// ------------------------------------------------------------------ wiring

function bindToggle(el: HTMLInputElement, key: ToggleKey): void {
  el.checked = state[key];
  el.addEventListener("change", () => {
    state[key] = el.checked;
    store.set(key, el.checked);
    render();
  });
}
bindToggle(els.drafts, "hideDrafts");
bindToggle(els.review, "onlyReview");
bindToggle(els.mine, "onlyMine");
bindToggle(els.showEmpty, "showEmpty");
bindToggle(els.watcher, "onlyWatcher");

els.sort.value = state.sort;
els.sort.addEventListener("change", () => {
  state.sort = els.sort.value as SortKey;
  store.set("sort", state.sort);
  render();
});

function setOwner(owner: string): void {
  state.owner = owner;
  store.set("owner", owner);
  render();
}
els.owner.addEventListener("change", () => setOwner(els.owner.value));

function setLayout(layout: Layout): void {
  state.layout = layout;
  store.set("layout", layout);
  render();
}
els.layout.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-layout]");
  if (btn) setLayout(btn.dataset.layout as Layout);
});

let filterTimer: number | undefined;
els.filter.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => { state.filter = els.filter.value; render(); }, 80);
});
els.refresh.addEventListener("click", () => void load(true));

document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "Escape" && document.activeElement === els.filter) {
    els.filter.value = "";
    state.filter = "";
    els.filter.blur();
    render();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    els.filter.focus();
    els.filter.select();
  } else if (e.key === "r") {
    void load(true);
  } else if (e.key === "g") {
    setLayout(state.layout === "grid" ? "list" : "grid");
  } else if (/^[1-9]$/.test(e.key)) {
    const ids = [ALL_VIEW, ...state.views.map((v) => v.id)];
    const id = ids[Number(e.key) - 1];
    if (id) setActiveView(id);
  }
});

window.addEventListener("hashchange", () => {
  const id = viewFromHash() ?? ALL_VIEW;
  if (id !== state.activeView && (id === ALL_VIEW || state.views.some((v) => v.id === id))) setActiveView(id);
});
document.addEventListener("visibilitychange", () => {
  const d = state.data;
  if (!document.hidden && d && Date.now() - +new Date(d.generatedAt) > d.refreshSeconds * 1000) void load(false);
});
setInterval(renderFooter, 30_000);

// Boot: views first (cheap, local) so tabs appear right away, then PR data.
const fromHash = viewFromHash();
if (fromHash) state.activeView = fromHash;
await loadViews();
setActiveView(state.activeView, false);
render();
void load(false);
