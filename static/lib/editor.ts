// Dialog for creating / editing / deleting a saved view.
import type { Repo, View } from "../../src/types.ts";
import { ICON, h, svg } from "./dom.ts";
import { isPattern, ownerOf, ownersIn, viewExcluder, viewMatcher } from "./state.ts";

const ENTRY_RE = /^[A-Za-z0-9_.*?-]+\/[A-Za-z0-9_.*?-]+$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface EditorOptions {
  view: View | null; // null = new view
  repos: Repo[]; // every repo the dashboard knows about
  onSave: (view: View) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function newId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "view";
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

const ownerAvatar = (owner: string, px = 16) =>
  h("img", { class: "avatar", src: `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=${px * 2}`, alt: "", loading: "lazy" });

/** Add/remove a case-insensitive entry in a list, in place. */
function toggle(list: string[], value: string, on: boolean): void {
  const i = list.findIndex((e) => e.toLowerCase() === value.toLowerCase());
  if (on && i < 0) list.push(value);
  if (!on && i >= 0) list.splice(i, 1);
}

export function openViewEditor(opts: EditorOptions): void {
  const owners: string[] = [...(opts.view?.owners ?? [])];
  const entries: string[] = [...(opts.view?.repos ?? [])];
  const excluded: string[] = [...(opts.view?.exclude ?? [])];
  const allRepos = [...opts.repos].sort((a, b) => a.name.localeCompare(b.name));
  const knownOwners = ownersIn(allRepos);

  const nameInput = h("input", { type: "text", maxlength: 60, placeholder: "e.g. Platform, My repos", value: opts.view?.name ?? "" });
  const ownerInput = h("input", { type: "text", placeholder: "Add another user or org, e.g. vercel", autocomplete: "off" });
  const ownerChips = h("div", { class: "ed-owners", role: "group", "aria-label": "Owners" });
  const search = h("input", { type: "search", placeholder: "Search repos…", autocomplete: "off" });
  const patternInput = h("input", { type: "text", placeholder: "owner/name or pattern, e.g. my-org/web-*", autocomplete: "off" });
  const list = h("div", { class: "ed-list", role: "group", "aria-label": "Repos" });
  const chips = h("div", { class: "ed-chips" });
  const summary = h("span", { class: "muted" });
  const error = h("div", { class: "ed-error", role: "alert" });
  const saveBtn = h("button", { type: "button", class: "primary" }, "Save view");

  function refresh(): void {
    // Owners: everything we know about, plus any added by hand.
    const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
    const extraOwners = owners.filter((o) => !knownOwners.some((k) => k.owner.toLowerCase() === o.toLowerCase()));
    ownerChips.replaceChildren(
      ...knownOwners.map((k) => {
        const on = ownerSet.has(k.owner.toLowerCase());
        return h("button", {
          type: "button", class: "owner-chip" + (on ? " on" : ""), "aria-pressed": String(on),
          title: `${k.repos} repo${k.repos === 1 ? "" : "s"}, ${k.prs} open PR${k.prs === 1 ? "" : "s"}`,
          onclick: () => { toggle(owners, k.owner, !on); refresh(); },
        }, ownerAvatar(k.owner), k.owner, h("span", { class: "owner-n" }, k.repos));
      }),
      ...extraOwners.map((o) => h("button", {
        type: "button", class: "owner-chip on", "aria-pressed": "true", title: "Fetched when you save",
        onclick: () => { toggle(owners, o, false); refresh(); },
      }, ownerAvatar(o), o, h("span", { class: "owner-n" }, "new"))),
    );

    // Individual repos. A repo that comes in through an owner or pattern can be unticked,
    // which puts it on the exclude list instead of removing an entry.
    const exact = new Set(entries.map((e) => e.toLowerCase()));
    const byPattern = viewMatcher({ owners: [], repos: entries.filter(isPattern) });
    const hidden = viewExcluder({ exclude: excluded });
    const q = search.value.trim().toLowerCase();
    const shown = allRepos.filter((r) => !q || r.name.toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown.map((r) => {
      const lower = r.name.toLowerCase();
      const viaOwner = ownerSet.has(ownerOf(lower));
      const viaPattern = !viaOwner && !exact.has(lower) && byPattern(r.name);
      const implied = viaOwner || viaPattern;
      const isHidden = hidden(r.name);
      const why = isHidden ? "Hidden from this view. Tick to show it again."
        : viaOwner ? `Included because ${ownerOf(r.name)} is selected. Untick to hide it.`
        : viaPattern ? "Included by a pattern. Untick to hide it." : null;
      return h("label", { class: "ed-row" + (isHidden ? " is-hidden" : ""), title: why },
        h("input", {
          type: "checkbox",
          checked: (exact.has(lower) || implied) && !isHidden,
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            if (isHidden || implied) toggle(excluded, r.name, !on);
            else toggle(entries, r.name, on);
            refresh();
          },
        }),
        h("span", { class: "ed-name" }, r.name),
        r.isPrivate ? svg(ICON.lock, 11, "muted") : null,
        isHidden ? h("span", { class: "badge hidden" }, "hidden")
          : viaOwner ? h("span", { class: "badge" }, "owner") : viaPattern ? h("span", { class: "badge" }, "pattern") : null,
        h("span", { class: "count" + (r.openCount ? "" : " zero") }, r.openCount));
    }) : [h("div", { class: "muted ed-none" }, "No repos match. Add it by name below.")]));

    // Everything in the view.
    chips.replaceChildren(
      ...owners.map((o) => h("span", { class: "chip owner" }, ownerAvatar(o, 14), o + " (all repos)",
        h("button", { type: "button", title: `Remove ${o}`, "aria-label": `Remove ${o}`, onclick: () => { toggle(owners, o, false); refresh(); } }, svg(ICON.x, 12)))),
      ...entries.map((e) => h("span", { class: "chip" + (isPattern(e) ? " pattern" : "") }, e,
        h("button", { type: "button", title: `Remove ${e}`, "aria-label": `Remove ${e}`, onclick: () => { toggle(entries, e, false); refresh(); } }, svg(ICON.x, 12)))),
      ...excluded.map((e) => h("span", { class: "chip hidden", title: "Hidden from this view" }, svg(ICON.eyeClosed, 12), e,
        h("button", { type: "button", title: `Show ${e} again`, "aria-label": `Show ${e} again`, onclick: () => { toggle(excluded, e, false); refresh(); } }, svg(ICON.x, 12)))),
    );
    const matcher = viewMatcher({ owners, repos: entries, exclude: excluded });
    const matched = allRepos.filter((r) => matcher(r.name)).length;
    const parts: string[] = [];
    if (owners.length) parts.push(`${owners.length} owner${owners.length === 1 ? "" : "s"}`);
    if (entries.length) parts.push(`${entries.length} repo entr${entries.length === 1 ? "y" : "ies"}`);
    if (excluded.length) parts.push(`${excluded.length} hidden`);
    summary.textContent = parts.length ? `${parts.join(" + ")} · ${matched} repo${matched === 1 ? "" : "s"} match` : "Nothing selected";
  }

  function addOwner(): void {
    const v = ownerInput.value.trim().replace(/^@/, "").replace(/\/\*?$/, "");
    if (!v) return;
    if (!OWNER_RE.test(v)) { error.textContent = `"${v}" isn't a valid GitHub user or org name.`; return; }
    error.textContent = "";
    toggle(owners, v, true);
    ownerInput.value = "";
    refresh();
  }

  function addPattern(): void {
    const v = patternInput.value.trim();
    if (!v) return;
    if (!ENTRY_RE.test(v)) { error.textContent = `"${v}" isn't owner/name or a pattern like owner/web-*.`; return; }
    error.textContent = "";
    const whole = /^([A-Za-z0-9-]+)\/\*$/.exec(v);
    if (whole) toggle(owners, whole[1], true); // "owner/*" is the same as picking the owner
    else toggle(entries, v, true);
    patternInput.value = "";
    refresh();
  }

  search.addEventListener("input", refresh);
  ownerInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addOwner(); } });
  patternInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPattern(); } });

  const dialog = h("dialog", { class: "editor", "aria-labelledby": "ed-title" });
  const close = () => dialog.close();

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { error.textContent = "Give the view a name."; nameInput.focus(); return; }
    if (!owners.length && !entries.length) { error.textContent = "Pick at least one owner or repo."; return; }
    saveBtn.disabled = true;
    error.textContent = "";
    try {
      await opts.onSave({ id: opts.view?.id ?? newId(name), name, owners: [...owners], repos: [...entries], exclude: [...excluded] });
      close();
    } catch (e) {
      error.textContent = (e as Error).message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  let armed = false;
  const deleteBtn = opts.view ? h("button", { type: "button", class: "danger" }, "Delete view") : null;
  deleteBtn?.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      deleteBtn.textContent = "Click again to delete";
      return;
    }
    try {
      await opts.onDelete(opts.view!.id);
      close();
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  });

  dialog.append(
    h("form", { method: "dialog", class: "ed-form", onsubmit: (e: Event) => e.preventDefault() },
      h("header", { class: "ed-head" },
        h("h2", { id: "ed-title" }, opts.view ? "Edit view" : "New view"),
        h("button", { type: "button", class: "icon", "aria-label": "Close", onclick: close }, svg(ICON.x, 16))),
      h("label", { class: "ed-field" }, h("span", null, "Name"), nameInput),
      h("div", { class: "ed-field" },
        h("span", null, "Owners & orgs"),
        ownerChips,
        h("div", { class: "ed-add" }, ownerInput, h("button", { type: "button", onclick: addOwner }, "Add")),
        h("div", { class: "ed-hint muted" },
          "Selecting an owner includes all of their repos, including ones created later. Owners outside your usual repos are fetched too."),
      ),
      h("div", { class: "ed-field" },
        h("span", null, "Individual repos"),
        search,
        list,
        h("div", { class: "ed-add" }, patternInput, h("button", { type: "button", onclick: addPattern }, "Add")),
        h("div", { class: "ed-hint muted" },
          "Patterns like ", h("code", null, "my-org/web-*"), " match by name. Repos you add by name are fetched even if they aren't yours. ",
          "Untick a repo that an owner or pattern brings in to hide it from this view."),
      ),
      h("div", { class: "ed-field" }, h("span", null, "In this view"), chips),
      error,
      h("footer", { class: "ed-foot" },
        deleteBtn, h("span", { class: "spacer" }), summary,
        h("button", { type: "button", onclick: close }, "Cancel"), saveBtn),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  refresh();
  dialog.showModal();
  (opts.view ? search : nameInput).focus();
}
