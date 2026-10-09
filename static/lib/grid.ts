// Grid layout: one card per repo with a compact PR list.
import type { PullRequest, Repo } from "../../src/types.ts";
import { ICON, ago, daysSince, h, link, svg } from "./dom.ts";
import { CI, REVIEW, avatarUrl, expandButton, hideButton, moreOnGitHub } from "./list.ts";
import { state, type RepoView } from "./state.ts";
import { watcherDot } from "./watcher.ts";

const CARD_CAP = 5; // PRs per card before "Show N more"

export function renderGrid(items: RepoView[], empty: Repo[]): HTMLElement {
  return h("div", { class: "grid" },
    items.map(({ repo, prs }) => card(repo, prs)),
    empty.map((repo) => card(repo, [])));
}

function card(repo: Repo, prs: PullRequest[]): HTMLElement {
  const [owner, name] = repo.name.split("/");
  const expanded = state.expanded.has(repo.name);
  const review = prs.filter((p) => p.reviewRequestedFromMe).length;
  const failing = prs.filter((p) => p.ci === "FAILURE" || p.ci === "ERROR").length;
  const approved = prs.filter((p) => p.review === "APPROVED").length;
  const drafts = prs.filter((p) => p.isDraft).length;
  const watcher = prs.filter((p) => (p.watcher?.open ?? 0) > 0).length;
  const stats = [
    review ? h("span", { class: "gstat you" }, `${review} need your review`) : null,
    failing ? h("span", { class: "gstat bad" }, `${failing} failing`) : null,
    watcher ? h("span", { class: "gstat bad" }, `${watcher} with open Watcher findings`) : null,
    approved ? h("span", { class: "gstat good" }, `${approved} approved`) : null,
    drafts ? h("span", { class: "gstat" }, `${drafts} draft${drafts > 1 ? "s" : ""}`) : null,
  ].filter((x): x is HTMLSpanElement => !!x);

  return h("section", { class: "gcard" + (prs.length ? "" : " is-empty") },
    h("header", { class: "gcard-head" },
      repo.languageColor ? h("span", { class: "lang-dot", style: `background:${repo.languageColor}`, title: repo.language }) : null,
      link(repo.url + "/pulls", { class: "gcard-name", title: repo.description ?? repo.name },
        h("span", { class: "owner" }, owner + " / "), name),
      repo.isPrivate ? h("span", { class: "glock", title: "Private" }, svg(ICON.lock, 12)) : null,
      repo.isArchived ? h("span", { class: "badge" }, "archived") : null,
      hideButton(repo, 12),
      h("span", { class: "count" + (prs.length ? "" : " zero"), title: `${repo.openCount} open` },
        prs.length === repo.openCount ? repo.openCount : `${prs.length}/${repo.openCount}`),
    ),
    stats.length ? h("div", { class: "gcard-stats" }, stats) : null,
    prs.length
      ? h("ul", { class: "gpr-list" }, (expanded ? prs : prs.slice(0, CARD_CAP)).map(row))
      : h("div", { class: "gcard-empty" }, repo.openCount ? "No PRs match your filters" : "No open PRs"),
    expandButton(repo.name, prs.length, CARD_CAP),
    moreOnGitHub(repo),
  );
}

function row(pr: PullRequest): HTMLElement {
  const review = pr.review ? REVIEW[pr.review] : null;
  const avatar = avatarUrl(pr, 14);
  return h("li", { class: "gpr" + (pr.isDraft ? " is-draft" : "") + (pr.reviewRequestedFromMe ? " attn" : "") },
    svg(pr.isDraft ? ICON.draft : ICON.pr, 14, "pr-icon " + (pr.isDraft ? "draft" : "open")),
    h("div", { class: "gpr-main" },
      link(pr.url, { class: "gpr-title", title: pr.title }, pr.title, " ", h("span", { class: "pr-num" }, "#" + pr.number)),
      h("div", { class: "gpr-meta" },
        avatar ? h("img", { class: "avatar", src: avatar, alt: "", loading: "lazy" }) : null,
        h("span", null, pr.author),
        watcherDot(pr),
        h("span", { class: daysSince(pr.updatedAt) > 14 ? "stale" : "", title: "Updated " + new Date(pr.updatedAt).toLocaleString() },
          ago(pr.updatedAt)),
        pr.isDraft ? h("span", { class: "badge draft" }, "Draft") : null,
        pr.reviewRequestedFromMe ? h("span", { class: "badge you" }, "Your review") : null,
        review && !pr.reviewRequestedFromMe ? h("span", { class: "badge " + review[0] }, review[1]) : null,
      ),
    ),
    pr.ci ? h("span", { class: "ci " + pr.ci, title: `Checks ${CI[pr.ci]}` }, h("span", { class: "dot" })) : h("span"),
  );
}
