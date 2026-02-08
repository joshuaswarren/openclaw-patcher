import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";
import type { PRMetadata, PRFile } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Fetch PR metadata and files using gh CLI (primary) or fetch API (fallback)
 */
export async function fetchPR(prNumber: number, repo: string): Promise<PRMetadata> {
  let ghErrorMsg: string | undefined;

  // Try gh CLI first (authenticated, higher rate limits)
  try {
    const result = await fetchPRWithGh(prNumber, repo);
    log.debug(`fetched PR #${prNumber} via gh CLI`);
    return result;
  } catch (ghError) {
    ghErrorMsg = ghError instanceof Error ? ghError.message : String(ghError);
    log.debug(`gh CLI failed, falling back to fetch API: ${ghErrorMsg}`);
  }

  // Fallback to fetch API (unauthenticated, 60 req/hour)
  try {
    const result = await fetchPRWithFetch(prNumber, repo);
    log.debug(`fetched PR #${prNumber} via fetch API`);
    return result;
  } catch (fetchError) {
    const fetchErrorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new Error(
      `Failed to fetch PR #${prNumber} from ${repo}: ` +
      `gh CLI: ${ghErrorMsg ?? "unknown"}, ` +
      `fetch: ${fetchErrorMsg}`
    );
  }
}

/**
 * Fetch PR using gh CLI
 */
async function fetchPRWithGh(prNumber: number, repo: string): Promise<PRMetadata> {
  // Fetch PR metadata
  const { stdout: prJson } = await execFileAsync("gh", [
    "api",
    `repos/${repo}/pulls/${prNumber}`,
    "--jq",
    ".",
  ]);

  const prData = JSON.parse(prJson) as {
    number: number;
    title: string;
    body: string;
    html_url: string;
    state: string;
  };

  // Fetch PR files with diffs
  const { stdout: filesJson } = await execFileAsync("gh", [
    "api",
    `repos/${repo}/pulls/${prNumber}/files`,
    "--jq",
    ".",
  ]);

  const filesData = JSON.parse(filesJson) as Array<{
    filename: string;
    status: string;
    patch?: string;
  }>;

  const files: PRFile[] = filesData.map((f) => ({
    path: f.filename,
    status: f.status,
    patch: f.patch ?? "",
  }));

  return {
    number: prData.number,
    title: prData.title,
    body: prData.body ?? "",
    url: prData.html_url,
    state: prData.state,
    files,
  };
}

/**
 * Fetch PR using fetch API (fallback, unauthenticated)
 */
async function fetchPRWithFetch(prNumber: number, repo: string): Promise<PRMetadata> {
  const baseUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;

  // Fetch PR metadata
  const prResponse = await fetch(baseUrl, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openclaw-patcher",
    },
  });

  if (!prResponse.ok) {
    if (prResponse.status === 404) {
      throw new Error(`PR #${prNumber} not found in ${repo}`);
    }
    if (prResponse.status === 403) {
      throw new Error(`Rate limited by GitHub API (60 req/hour for unauthenticated requests)`);
    }
    throw new Error(`GitHub API returned ${prResponse.status}: ${prResponse.statusText}`);
  }

  const prData = (await prResponse.json()) as {
    number: number;
    title: string;
    body: string;
    html_url: string;
    state: string;
  };

  // Fetch PR files
  const filesResponse = await fetch(`${baseUrl}/files`, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openclaw-patcher",
    },
  });

  if (!filesResponse.ok) {
    throw new Error(`Failed to fetch PR files: ${filesResponse.status}`);
  }

  const filesData = (await filesResponse.json()) as Array<{
    filename: string;
    status: string;
    patch?: string;
  }>;

  const files: PRFile[] = filesData.map((f) => ({
    path: f.filename,
    status: f.status,
    patch: f.patch ?? "",
  }));

  return {
    number: prData.number,
    title: prData.title,
    body: prData.body ?? "",
    url: prData.html_url,
    state: prData.state,
    files,
  };
}

/**
 * Fetch the raw diff for a PR (unified diff format)
 */
export async function fetchPRDiff(prNumber: number, repo: string): Promise<string> {
  // Try gh CLI first
  try {
    const { stdout } = await execFileAsync("gh", [
      "api",
      `repos/${repo}/pulls/${prNumber}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
    ]);
    return stdout;
  } catch {
    // Fallback to fetch
    const response = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Accept: "application/vnd.github.v3.diff",
          "User-Agent": "openclaw-patcher",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch PR diff: ${response.status}`);
    }

    return response.text();
  }
}
