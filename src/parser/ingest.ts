import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initParsers, extractFile } from "./extract.js";
import { buildGraph } from "./graph.js";
import { persistGraph } from "./graph-store.js";
import { chunkSymbols, embedChunks } from "../embeddings/embed.js";
import { upsertChunks } from "../embeddings/vector-store.js";
import type { FileGraph } from "./extract.js";
import type { BuildResult } from "./graph.js";

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

export type IngestSource =
  | { kind: "local"; dir: string }
  | { kind: "github"; owner: string; repo: string; ref?: string };

export type IngestResult = {
  source: IngestSource;
  repoKey: string;
  fileGraphs: FileGraph[];
  build: BuildResult;
  skipped: { file: string; reason: string }[];
  persisted: boolean;
  // Full source text per file (same relative path used as FileGraph.file),
  // kept around so embed.ts can slice exact symbol line ranges without
  // re-reading local files or re-fetching GitHub content.
  sources: Map<string, string>;
  embeddedCount: number;
  vectorsWritten: boolean;
};

/**
 * Accepts a local directory path, a full GitHub URL
 * (https://github.com/owner/repo[/tree/ref]), or an "owner/repo" shorthand.
 * A bare "owner/repo"-shaped string is only treated as GitHub if no local
 * directory of that name exists — avoids guessing wrong for relative paths
 * that happen to have one slash in them.
 */
export function parseSource(input: string): IngestSource {
  const trimmed = input.trim();

  if (/^https?:\/\/(www\.)?github\.com\//.test(trimmed)) {
    const url = new URL(trimmed);
    const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
    const [owner, repoRaw, treeKeyword, ...refParts] = parts;
    if (!owner || !repoRaw) {
      throw new Error(`Could not parse owner/repo from GitHub URL: ${trimmed}`);
    }
    const repo = repoRaw.replace(/\.git$/, "");
    const ref = treeKeyword === "tree" && refParts.length ? refParts.join("/") : undefined;
    return { kind: "github", owner, repo, ref };
  }

  // Anything that looks path-shaped (relative/absolute/drive-letter/already
  // on disk) is local, full stop — even if it happens to contain exactly one
  // slash and could otherwise be mistaken for "owner/repo".
  const looksLikeLocalPath =
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    fs.existsSync(trimmed);

  if (!looksLikeLocalPath) {
    const shorthandMatch = /^([\w-]+)\/([\w.-]+)$/.exec(trimmed);
    if (shorthandMatch) {
      return { kind: "github", owner: shorthandMatch[1], repo: shorthandMatch[2] };
    }
  }

  if (!fs.existsSync(trimmed) || !fs.statSync(trimmed).isDirectory()) {
    throw new Error(
      `"${input}" is neither a GitHub URL/shorthand (owner/repo) nor an existing local directory.`
    );
  }
  return { kind: "local", dir: trimmed };
}

function repoKeyFor(source: IngestSource): string {
  return source.kind === "github"
    ? `github:${source.owner}/${source.repo}@${source.ref ?? "default"}`
    : `local:${path.resolve(source.dir)}`;
}

function isCodeFile(name: string): boolean {
  return CODE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith(".d.ts");
}

function walkLocalDir(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && isCodeFile(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  walk(root);
  return out;
}

async function loadLocalFileGraphs(
  dir: string
): Promise<{ fileGraphs: FileGraph[]; skipped: IngestResult["skipped"]; sources: Map<string, string> }> {
  const absFiles = walkLocalDir(dir);
  const fileGraphs: FileGraph[] = [];
  const skipped: IngestResult["skipped"] = [];
  const sources = new Map<string, string>();
  for (const abs of absFiles) {
    const rel = path.relative(dir, abs).replace(/\\/g, "/");
    try {
      const source = fs.readFileSync(abs, "utf-8");
      fileGraphs.push(extractFile(rel, source));
      sources.set(rel, source);
    } catch (e: any) {
      skipped.push({ file: rel, reason: e.message ?? String(e) });
    }
  }
  return { fileGraphs, skipped, sources };
}

// --- GitHub REST API ---------------------------------------------------

const GITHUB_API = "https://api.github.com";

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const resetAt = res.headers.get("x-ratelimit-reset");
    const resetTime = resetAt ? new Date(Number(resetAt) * 1000).toLocaleTimeString() : "unknown";
    throw new Error(
      `GitHub API rate limit exceeded (resets ${resetTime}). ` +
        (process.env.GITHUB_TOKEN
          ? "Even with GITHUB_TOKEN set, the limit was hit — try again later."
          : "Set GITHUB_TOKEN to raise the limit from 60/hour to 5000/hour.")
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API request failed (${res.status} ${res.statusText}): ${url}`);
  }
  return res;
}

async function resolveDefaultRef(owner: string, repo: string): Promise<string> {
  const res = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}`);
  const data = (await res.json()) as { default_branch: string };
  return data.default_branch;
}

type GithubTreeEntry = { path: string; type: "blob" | "tree"; sha: string };

async function fetchGithubTree(owner: string, repo: string, ref: string): Promise<GithubTreeEntry[]> {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  );
  const data = (await res.json()) as { tree: GithubTreeEntry[]; truncated: boolean };
  if (data.truncated) {
    console.warn(
      `Warning: GitHub tree listing for ${owner}/${repo}@${ref} was truncated (repo too large for a ` +
        `single recursive listing) — some files were not ingested.`
    );
  }
  return data.tree;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadGithubFileGraphs(
  owner: string,
  repo: string,
  refInput: string | undefined
): Promise<{ fileGraphs: FileGraph[]; skipped: IngestResult["skipped"]; ref: string; sources: Map<string, string> }> {
  const ref = refInput ?? (await resolveDefaultRef(owner, repo));
  const tree = await fetchGithubTree(owner, repo, ref);
  const codeEntries = tree.filter((e) => e.type === "blob" && isCodeFile(e.path));

  const skipped: IngestResult["skipped"] = [];
  const fileGraphs: FileGraph[] = [];
  const sources = new Map<string, string>();

  // Raw content is served from a CDN (raw.githubusercontent.com), not the
  // rate-limited core API, so fetching one file at a time here doesn't
  // burn through the 60-5000/hour budget the tree listing above respects.
  // Still capped at a modest concurrency to be a polite client.
  await mapWithConcurrency(codeEntries, 8, async (entry) => {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${entry.path}`;
    try {
      const res = await fetch(rawUrl);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const source = await res.text();
      fileGraphs.push(extractFile(entry.path, source));
      sources.set(entry.path, source);
    } catch (e: any) {
      skipped.push({ file: entry.path, reason: e.message ?? String(e) });
    }
  });

  return { fileGraphs, skipped, ref, sources };
}

// --- Public entry point --------------------------------------------------

export async function ingest(input: string): Promise<IngestResult> {
  const source = parseSource(input);
  await initParsers();

  let fileGraphs: FileGraph[];
  let skipped: IngestResult["skipped"];
  let sources: Map<string, string>;
  let resolvedSource = source;

  if (source.kind === "local") {
    ({ fileGraphs, skipped, sources } = await loadLocalFileGraphs(source.dir));
  } else {
    const result = await loadGithubFileGraphs(source.owner, source.repo, source.ref);
    fileGraphs = result.fileGraphs;
    skipped = result.skipped;
    sources = result.sources;
    resolvedSource = { ...source, ref: result.ref };
  }

  const build = buildGraph(fileGraphs);
  const repoKey = repoKeyFor(resolvedSource);
  const persisted = await persistGraph(repoKey, build);

  const chunks = chunkSymbols(fileGraphs, sources);
  const embedded = await embedChunks(chunks);
  const vectorsWritten = await upsertChunks(repoKey, embedded);

  return {
    source: resolvedSource,
    repoKey,
    fileGraphs,
    build,
    skipped,
    persisted,
    sources,
    embeddedCount: embedded.length,
    vectorsWritten,
  };
}

// --- CLI ---------------------------------------------------------------

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: tsx src/parser/ingest.ts <local-dir | github-url | owner/repo>");
    process.exit(1);
  }

  const result = await ingest(input);

  console.log(`Source: ${JSON.stringify(result.source)}`);
  console.log(`Repo key: ${result.repoKey}`);
  console.log(`Persisted to Redis: ${result.persisted}`);
  console.log(`Embedded ${result.embeddedCount} symbols, written to Upstash Vector: ${result.vectorsWritten}`);
  console.log(`\n--- Stats ---`);
  console.log(result.build.stats);
  if (result.skipped.length) {
    console.log(`\n--- Skipped (${result.skipped.length}) ---`);
    for (const s of result.skipped.slice(0, 10)) console.log(`  ${s.file}: ${s.reason}`);
    if (result.skipped.length > 10) console.log(`  ... and ${result.skipped.length - 10} more`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
