import { DashError, type Config, type Tokens } from "./config.ts";
import type { CheckState, DashboardData, PullRequest, RateLimit, Repo, ReviewDecision } from "./types.ts";
import { globToRegExp } from "./views.ts";

// Override for GitHub Enterprise Server, e.g. https://github.example.com/api/graphql
const API_URL = process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";
const REPO_PAGE_SIZE = 25;
const EXPLICIT_BATCH = 20;

// --------------------------------------------------------------------------- queries

const REPO_FRAGMENT = /* GraphQL */ `
fragment RepoFields on Repository {
  nameWithOwner
  url
  description
  isPrivate
  isArchived
  isFork
  pushedAt
  primaryLanguage { name color }
  pullRequests(states: OPEN, first: $prs, orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount
    nodes {
      number
      title
      url
      isDraft
      createdAt
      updatedAt
      headRefName
      baseRefName
      reviewDecision
      additions
      deletions
      author { login avatarUrl url }
      comments { totalCount }
      labels(first: 6) { nodes { name color } }
      reviewRequests(first: 10) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}
`;

export const VIEWER_QUERY = REPO_FRAGMENT + /* GraphQL */ `
query($cursor: String, $n: Int!, $prs: Int!) {
  viewer {
    login
    repositories(first: $n, after: $cursor,
                 affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
                 ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
                 orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...RepoFields }
    }
  }
  rateLimit { limit remaining resetAt }
}
`;

export const OWNER_QUERY = REPO_FRAGMENT + /* GraphQL */ `
query($login: String!, $cursor: String, $n: Int!, $prs: Int!) {
  viewer { login }
  repositoryOwner(login: $login) {
    login
    repositories(first: $n, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...RepoFields }
    }
  }
  rateLimit { limit remaining resetAt }
}
`;

export function explicitQuery(count: number): string {
  const decls = ["$prs: Int!"];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    decls.push(`$o${i}: String!`, `$n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...RepoFields }`);
  }
  return REPO_FRAGMENT +
    `query(${decls.join(", ")}) {\n  viewer { login }\n  ${fields.join("\n  ")}\n  rateLimit { limit remaining resetAt }\n}`;
}

// --------------------------------------------------------------------------- raw GitHub shapes

interface RawPR {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  headRefName: string | null;
  baseRefName: string | null;
  reviewDecision: ReviewDecision | null;
  additions: number | null;
  deletions: number | null;
  author: { login: string; avatarUrl: string; url: string } | null;
  comments: { totalCount: number } | null;
  labels: { nodes: ({ name: string; color: string } | null)[] | null } | null;
  reviewRequests: {
    nodes: ({ requestedReviewer: { __typename: string; login?: string; slug?: string } | null } | null)[] | null;
  } | null;
  commits: { nodes: ({ commit: { statusCheckRollup: { state: CheckState } | null } | null } | null)[] | null } | null;
}

interface RawRepo {
  nameWithOwner: string;
  url: string;
  description: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string | null;
  primaryLanguage: { name: string; color: string | null } | null;
  pullRequests: { totalCount: number; nodes: (RawPR | null)[] | null };
}

interface RepoConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (RawRepo | null)[] | null;
}

interface QueryData {
  viewer?: { login: string; repositories?: RepoConnection } | null;
  repositoryOwner?: { login: string; repositories: RepoConnection } | null;
  rateLimit?: RateLimit | null;
  [alias: string]: unknown;
}

// --------------------------------------------------------------------------- transport

export async function graphql(token: string, query: string, variables: Record<string, unknown>):
  Promise<{ data: QueryData; errors: string[] }> {
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "pr-dash" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const reason = err.name === "TimeoutError" ? "timed out" : (err.cause?.code ?? err.cause?.message ?? err.message);
    throw new DashError(`Could not reach GitHub: ${reason}`, "Check your network connection.");
  }
  if (res.status === 401) {
    throw new DashError("GitHub rejected the token (401).",
      "Your token may be expired. Try `gh auth refresh` or a new token.", 401);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new DashError(`GitHub API returned HTTP ${res.status}: ${detail}`);
  }
  let payload: { data?: QueryData | null; errors?: { message?: string }[] };
  try {
    payload = await res.json() as typeof payload;
  } catch {
    throw new DashError("GitHub returned a response that wasn't JSON.");
  }
  const errors = (payload.errors ?? []).map((e) => e.message ?? "?");
  if (errors.length && !payload.data) throw new DashError(`GitHub API error: ${errors.join("; ")}`);
  return { data: payload.data ?? {}, errors };
}

interface Context {
  warnings: string[];
  viewer: string | null;
  rate: RateLimit | null;
}

/** Yield repos from a paginated `repositories` connection. Returns false if the owner is missing. */
async function* paginate(
  token: string, query: string, variables: Record<string, unknown>,
  pick: (d: QueryData) => RepoConnection | null | undefined, limit: number, ctx: Context,
): AsyncGenerator<RawRepo, boolean> {
  let cursor: string | null = null;
  let seen = 0;
  while (seen < limit) {
    const n = Math.min(REPO_PAGE_SIZE, limit - seen);
    const { data, errors } = await graphql(token, query, { ...variables, cursor, n });
    ctx.warnings.push(...errors);
    ctx.viewer = data.viewer?.login ?? ctx.viewer;
    ctx.rate = data.rateLimit ?? ctx.rate;
    const conn = pick(data);
    if (!conn) return false;
    for (const repo of conn.nodes ?? []) {
      if (repo) {
        seen++;
        yield repo;
      }
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return true;
}

async function fetchExplicit(token: string, names: string[], prs: number, ctx: Context): Promise<RawRepo[]> {
  const out: RawRepo[] = [];
  for (let start = 0; start < names.length; start += EXPLICIT_BATCH) {
    const batch = names.slice(start, start + EXPLICIT_BATCH);
    const variables: Record<string, unknown> = { prs };
    batch.forEach((full, i) => {
      const [owner, name] = full.split("/");
      variables[`o${i}`] = owner;
      variables[`n${i}`] = name;
    });
    const { data, errors } = await graphql(token, explicitQuery(batch.length), variables);
    ctx.viewer = data.viewer?.login ?? ctx.viewer;
    ctx.rate = data.rateLimit ?? ctx.rate;
    batch.forEach((full, i) => {
      const node = data[`r${i}`] as RawRepo | null | undefined;
      if (node) out.push(node);
      else ctx.warnings.push(`Repo not found or not accessible: ${full}`);
    });
    ctx.warnings.push(...errors.filter((e) => !e.includes("Could not resolve to a Repository")));
  }
  return out;
}

// --------------------------------------------------------------------------- collect

export interface ExtraSources {
  /** Exact owner/name repos named in saved views. */
  repos: string[];
  /** Users/orgs whose repos saved views want (view `owners` and "owner/*" entries). */
  owners: string[];
}

/**
 * Gather repos from every source: your repos (`mine`), configured `owners` plus owners from
 * saved views, explicit `repos` from config, and exact repos from saved views.
 * Explicit repos skip the archived/fork/exclude filters, since you asked for them by name.
 */
export async function collect(cfg: Config, tokens: Tokens, extra: ExtraSources = { repos: [], owners: [] }):
  Promise<Omit<DashboardData, "fetchMs" | "generatedAt" | "refreshSeconds">> {
  const extraRepos = extra.repos;
  const prs = cfg.prs_per_repo;
  const limit = Number(cfg.max_repos_per_source);
  const repos = new Map<string, RawRepo>();
  const explicit = new Set<string>();
  const ctx: Context = { warnings: [], viewer: null, rate: null };
  const add = (node: RawRepo) => {
    const key = node.nameWithOwner.toLowerCase();
    if (!repos.has(key)) repos.set(key, node);
  };

  if (cfg.mine) {
    const it = paginate(await tokens.default(), VIEWER_QUERY, { prs }, (d) => d.viewer?.repositories, limit, ctx);
    for await (const node of it) add(node);
  }

  const owners = new Map<string, string>();
  for (const o of [...cfg.owners, ...extra.owners]) if (!owners.has(o.toLowerCase())) owners.set(o.toLowerCase(), o);
  for (const owner of owners.values()) {
    const prefix = owner.toLowerCase() + "/";
    const it = paginate(await tokens.forOwner(owner), OWNER_QUERY, { prs, login: owner },
      (d) => d.repositoryOwner?.repositories, limit, ctx);
    let step = await it.next();
    while (!step.done) {
      if (step.value.nameWithOwner.toLowerCase().startsWith(prefix)) add(step.value);
      step = await it.next();
    }
    if (step.value === false) ctx.warnings.push(`User or org not found: ${owner}`);
  }

  const byOwner = new Map<string, string[]>();
  for (const raw of [...cfg.repos, ...extraRepos]) {
    const full = raw.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(full)) {
      ctx.warnings.push(`Ignoring repo entry (expected owner/name): ${raw}`);
      continue;
    }
    const key = full.toLowerCase();
    if (explicit.has(key)) continue;
    explicit.add(key);
    if (repos.has(key)) continue; // already fetched via mine/owners
    const owner = key.split("/")[0];
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), full]);
  }
  for (const [owner, group] of byOwner) {
    for (const node of await fetchExplicit(await tokens.forOwner(owner), group, prs, ctx)) add(node);
  }

  const excludes = cfg.exclude.map(globToRegExp);
  const result: Repo[] = [];
  for (const [key, node] of repos) {
    if (!explicit.has(key)) {
      if (excludes.some((re) => re.test(key))) continue;
      if (node.isArchived && !cfg.include_archived) continue;
      if (node.isFork && !cfg.include_forks) continue;
    }
    result.push(shapeRepo(node, ctx.viewer));
  }

  const warnings = [...new Set(ctx.warnings.filter((w) => !w.includes("Could not resolve to a RepositoryOwner")))].sort();
  return { viewer: ctx.viewer, rateLimit: ctx.rate, warnings, repos: result };
}

// --------------------------------------------------------------------------- shaping

function shapeRepo(node: RawRepo, viewer: string | null): Repo {
  return {
    name: node.nameWithOwner,
    url: node.url,
    description: node.description,
    isPrivate: node.isPrivate,
    isArchived: node.isArchived,
    isFork: node.isFork,
    pushedAt: node.pushedAt,
    language: node.primaryLanguage?.name ?? null,
    languageColor: node.primaryLanguage?.color ?? null,
    openCount: node.pullRequests.totalCount,
    prs: (node.pullRequests.nodes ?? []).filter((p): p is RawPR => !!p).map((p) => shapePr(p, viewer)),
  };
}

function shapePr(pr: RawPR, viewer: string | null): PullRequest {
  const users: string[] = [];
  const teams: string[] = [];
  for (const rr of pr.reviewRequests?.nodes ?? []) {
    const rev = rr?.requestedReviewer;
    if (rev?.login) users.push(rev.login);
    else if (rev?.slug) teams.push(rev.slug);
  }
  const me = (viewer ?? "").toLowerCase();
  const login = pr.author?.login ?? "ghost";
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    head: pr.headRefName,
    base: pr.baseRefName,
    review: pr.reviewDecision ?? null,
    ci: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    additions: pr.additions,
    deletions: pr.deletions,
    comments: pr.comments?.totalCount ?? 0,
    author: login,
    authorUrl: pr.author?.url ?? null,
    avatar: pr.author?.avatarUrl ?? null,
    labels: (pr.labels?.nodes ?? []).filter((l): l is { name: string; color: string } => !!l),
    requestedReviewers: users,
    requestedTeams: teams,
    isMine: !!me && login.toLowerCase() === me,
    reviewRequestedFromMe: !!me && users.some((u) => u.toLowerCase() === me),
  };
}
