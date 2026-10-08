// List layout: one full-width section per repo, one row per PR (the original view).
import type { CheckState, PullRequest, Repo, ReviewDecision } from "../../src/types.ts";
import { ICON, ago, daysSince, h, labelStyle, link, store, svg } from "./dom.ts";
import { hooks, state, type RepoView } from "./state.ts";
import { mergeIndicator, watcherBadges, watcherPanel } from "./watcher.ts";

const ROW_CAP = 10; // PRs shown per repo before "Show N more"

export const REVIEW: Record<ReviewDecision, [cls: string, label: string]> = {
  APPROVED: ["approved", "Approved"],
  CHANGES_REQUESTED: ["changes", "Changes requested"],
  REVIEW_REQUIRED: ["review", "Review required"],
};

export const CI: Record<CheckState, string> = {
  SUCCESS: "passing", FAILURE: "failing", ERROR: "errored", PENDING: "running", EXPECTED: "expected",
};

export function avatarUrl(pr: PullRequest, px: number): string | null {
  return pr.avatar ? pr.avatar + (pr.avatar.includes("?") ? "&" : "?") + "s=" + px * 2 : null;
}

export function expandButton(repoName: string, total: number, cap: number): HTMLElement | null {
  if (total <= cap) return null;
  const expanded = state.expanded.has(repoName);
  return h("div", { class: "more" }, h("button", {
    type: "button",
    class: "linkish",
    onclick: () => {
      if (expanded) state.expanded.delete(repoName);
      else state.expanded.add(repoName);
      hooks.render();
    },
  }, expanded ? "Show fewer" : `Show ${total - cap} more`));
}

export function moreOnGitHub(repo: Repo): HTMLElement | null {
  if (repo.openCount <= repo.prs.length) return null;
  return h("div", { class: "more" },
    link(repo.url + "/pulls", {}, `+${repo.openCount - repo.prs.length} more open on GitHub ↗`));
}

export function renderList(items: RepoView[]): HTMLElement[] {
  return items.map(renderRepo);
}

function renderRepo({ repo, prs }: RepoView): HTMLElement {
  const [owner, name] = repo.name.split("/");
  const expanded = state.expanded.has(repo.name);
  const card = h("section", { class: "repo" + (state.collapsed.has(repo.name) ? " collapsed" : "") });
  const toggle = (e: Event) => {
    if ((e.target as Element).closest("a")) return;
    const nowCollapsed = card.classList.toggle("collapsed");
    if (nowCollapsed) state.collapsed.add(repo.name);
    else state.collapsed.delete(repo.name);
    store.set("collapsed", [...state.collapsed]);
  };
  card.append(
    h("div", { class: "repo-head", onclick: toggle, title: "Click to collapse / expand" },
      svg(ICON.chev, 16, "chev"),
      repo.languageColor ? h("span", { class: "lang-dot", style: `background:${repo.languageColor}`, title: repo.language }) : null,
      link(repo.url, { class: "repo-name" }, h("span", { class: "owner" }, owner + " / "), name),
      repo.isPrivate ? h("span", { class: "badge private" }, svg(ICON.lock, 11), "private") : null,
      repo.isArchived ? h("span", { class: "badge" }, "archived") : null,
      h("span", { class: "repo-desc" }, repo.description ?? ""),
      link(repo.url + "/pulls", { class: "all" }, "all PRs ↗"),
      h("span", { class: "count", title: `${repo.openCount} open` },
        prs.length === repo.openCount ? repo.openCount : `${prs.length}/${repo.openCount}`),
    ),
    h("ul", { class: "pr-list" }, (expanded ? prs : prs.slice(0, ROW_CAP)).map(renderPr)),
  );
  const more = expandButton(repo.name, prs.length, ROW_CAP);
  const gh = moreOnGitHub(repo);
  if (more) card.append(more);
  if (gh) card.append(gh);
  return card;
}

function renderPr(pr: PullRequest): HTMLElement {
  const review = pr.review ? REVIEW[pr.review] : null;
  const reviewers = [...pr.requestedReviewers, ...pr.requestedTeams.map((t) => "@" + t)];
  const avatar = avatarUrl(pr, 16);
  return h("li", { class: "pr" + (pr.isDraft ? " is-draft" : "") + (pr.reviewRequestedFromMe ? " attn" : "") },
    svg(pr.isDraft ? ICON.draft : ICON.pr, 16, "pr-icon " + (pr.isDraft ? "draft" : "open")),
    h("div", { class: "pr-main" },
      h("div", { class: "pr-title-row" },
        link(pr.url, { class: "pr-title" }, pr.title, " ", h("span", { class: "pr-num" }, "#" + pr.number)),
        pr.isDraft ? h("span", { class: "badge draft" }, "Draft") : null,
        pr.reviewRequestedFromMe ? h("span", { class: "badge you" }, "Your review") : null,
        review ? h("span", { class: "badge " + review[0] }, review[1]) : null,
        ...watcherBadges(pr),
        pr.labels.length ? h("span", { class: "labels" },
          pr.labels.map((l) => h("span", { class: "label", style: labelStyle(l.color) }, l.name))) : null,
      ),
      h("div", { class: "pr-meta" },
        link(pr.authorUrl ?? "#", { class: "who" },
          avatar ? h("img", { class: "avatar", src: avatar, alt: "", loading: "lazy" }) : null,
          pr.author, pr.isMine ? h("span", { class: "badge mine" }, "you") : null),
        h("span", null,
          h("span", { class: "branch", title: `${pr.head} → ${pr.base}` }, pr.head), " → ",
          h("span", { class: "branch" }, pr.base)),
        h("span", { title: new Date(pr.createdAt).toLocaleString() }, "opened " + ago(pr.createdAt)),
        h("span", { class: daysSince(pr.updatedAt) > 14 ? "stale" : "", title: new Date(pr.updatedAt).toLocaleString() },
          "updated " + ago(pr.updatedAt)),
        reviewers.length ? h("span", null, "reviewers: " + reviewers.join(", ")) : null,
      ),
    ),
    h("div", { class: "pr-side" },
      mergeIndicator(pr),
      pr.ci ? h("span", { class: "ci " + pr.ci, title: `Checks ${CI[pr.ci]}` }, h("span", { class: "dot" }), CI[pr.ci]) : null,
      h("span", { class: "diff" },
        h("span", { class: "add" }, "+" + (pr.additions ?? 0)), " ",
        h("span", { class: "del" }, "−" + (pr.deletions ?? 0))),
      pr.comments ? h("span", { class: "ci", title: `${pr.comments} comments` }, svg(ICON.comment, 12), pr.comments) : null,
    ),
    watcherPanel(pr),
  );
}

/** Repos with no open PRs, as a compact link list under the list layout. */
export function renderEmptyList(empty: Repo[], open: boolean): HTMLElement | null {
  if (!empty.length) return null;
  return h("details", { open },
    h("summary", null, `${empty.length} repo${empty.length > 1 ? "s" : ""} with no open PRs`),
    h("div", { class: "empty-list" }, empty.map((r) => link(r.url, {}, r.name))));
}
