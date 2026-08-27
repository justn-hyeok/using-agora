import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewResult } from "@using-agora/contracts";

import { runAction } from "./index.js";

const originalFetch = globalThis.fetch;
const event = JSON.stringify({
  pull_request: {
    number: 7,
    head: { sha: "head-a", repo: { full_name: "acme/repo" } },
    base: { repo: { full_name: "acme/repo" } },
  },
  repository: { full_name: "acme/repo" },
});

const completedReview: ReviewResult = {
  schemaVersion: 1,
  runStatus: "COMPLETED",
  verdict: "PASS",
  reviewedHeadSha: "head-a",
  findings: [],
};

function environment(): Record<string, string> {
  return {
    GITHUB_EVENT_PATH: "/event.json",
    GITHUB_REPOSITORY: "acme/repo",
    "INPUT_GITHUB-TOKEN": "github-token",
    "INPUT_OPENROUTER-API-KEY": "openrouter-token",
  };
}

function githubFetch(headShas: string[], requests: Request[]): typeof fetch {
  let headIndex = 0;
  return (async (input, init) => {
    const url = String(input);
    requests.push(new Request(url, init));
    if (url.includes("/pulls/7")) {
      const accept = new Headers(init?.headers).get("Accept");
      if (accept === "application/vnd.github.diff")
        return new Response("diff --git a/a b/a");
      return Response.json({
        head: { sha: headShas[headIndex++] ?? headShas.at(-1) },
      });
    }
    if (url.includes("/check-runs?")) return Response.json({ check_runs: [] });
    return Response.json({ id: 100 }, { status: 201 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("skips a non-pull-request event without calling GitHub", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response();
  }) as typeof fetch;

  const result = await runAction(environment(), {
    readEvent: async () =>
      JSON.stringify({ repository: { full_name: "acme/repo" } }),
    writeOutput: async () => {},
  });

  expect(result).toMatchObject({ runStatus: "SKIPPED", verdict: null });
  expect(fetchCalls).toBe(0);
});

test("marks a completed review stale when the head changes before reporting", async () => {
  const requests: Request[] = [];
  globalThis.fetch = githubFetch(["head-a", "head-b"], requests);

  const result = await runAction(environment(), {
    readEvent: async () => event,
    review: async () => completedReview,
    createReviewers: () => [],
    writeOutput: async () => {},
  });

  expect(result).toMatchObject({
    runStatus: "STALE",
    verdict: "PASS",
    reviewedHeadSha: "head-a",
  });
  expect(requests.some((request) => request.url.includes("/check-runs"))).toBe(
    false,
  );
});

test("skips fork pull requests before using a provider credential", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run");
  }) as typeof fetch;
  const forkEvent = JSON.stringify({
    pull_request: {
      number: 7,
      head: { sha: "head-a", repo: { full_name: "contributor/repo" } },
      base: { repo: { full_name: "acme/repo" } },
    },
    repository: { full_name: "acme/repo" },
  });

  const result = await runAction(
    { ...environment(), "INPUT_OPENROUTER-API-KEY": "" },
    { readEvent: async () => forkEvent, writeOutput: async () => {} },
  );

  expect(result).toMatchObject({
    runStatus: "SKIPPED",
    reason: "Pull request originates from a fork",
  });
});

test("skips pull requests when the OpenRouter credential is missing", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response();
  }) as typeof fetch;

  const result = await runAction(
    { ...environment(), "INPUT_OPENROUTER-API-KEY": "" },
    { readEvent: async () => event, writeOutput: async () => {} },
  );

  expect(result).toMatchObject({
    runStatus: "SKIPPED",
    reason: "OpenRouter API key is not configured",
  });
  expect(fetchCalls).toBe(0);
});

test("creates a check run after a successful review", async () => {
  const requests: Request[] = [];
  globalThis.fetch = githubFetch(["head-a", "head-a"], requests);

  const result = await runAction(environment(), {
    readEvent: async () => event,
    review: async () => completedReview,
    createReviewers: () => [],
    writeOutput: async () => {},
  });

  const createRequest = requests.find((request) => request.method === "POST");
  expect(result).toEqual(completedReview);
  expect(createRequest).toBeDefined();
  const createBody = createRequest
    ? JSON.parse(await createRequest.text())
    : undefined;
  expect(createRequest?.url).toBe(
    "https://api.github.com/repos/acme/repo/check-runs",
  );
  expect(createBody).toMatchObject({
    name: "using-agora",
    head_sha: "head-a",
    conclusion: "success",
  });
});

test("reports a rejected review as failed", async () => {
  const requests: Request[] = [];
  globalThis.fetch = githubFetch(["head-a"], requests);

  const result = await runAction(environment(), {
    readEvent: async () => event,
    review: async () => {
      throw new Error("reviewer rejected request");
    },
    createReviewers: () => [],
    writeOutput: async () => {},
  });

  expect(result).toMatchObject({
    runStatus: "FAILED",
    verdict: null,
    reviewedHeadSha: "head-a",
    reason: "reviewer rejected request",
  });
  expect(requests.some((request) => request.method === "POST")).toBe(true);
});

test("marks reporting failures failed without discarding a completed verdict", async () => {
  const result = await runAction(environment(), {
    readEvent: async () => event,
    getDiff: async () => "diff --git a/a b/a",
    getHeadSha: async () => "head-a",
    review: async () => completedReview,
    createReviewers: () => [],
    reportCheck: async () => {
      throw new Error("checks permission denied");
    },
    writeOutput: async () => {},
  });

  expect(result).toMatchObject({
    runStatus: "FAILED",
    verdict: "PASS",
    reviewedHeadSha: "head-a",
    reason: "Check Run reporting failed: checks permission denied",
  });
});

test("uses a random delimiter for each GitHub output write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "using-agora-action-"));
  const outputPath = join(directory, "github-output");

  try {
    await runAction(
      { ...environment(), GITHUB_OUTPUT: outputPath },
      {
        readEvent: async () => event,
        getDiff: async () => "diff --git a/a b/a",
        getHeadSha: async () => "head-a",
        review: async () => completedReview,
        createReviewers: () => [],
        reportCheck: async () => {},
      },
    );

    const output = await readFile(outputPath, "utf8");
    const delimiters = [...output.matchAll(/<<(USING_AGORA_[\w-]+)/g)].map(
      (match) => match[1],
    );
    expect(delimiters).toHaveLength(5);
    expect(new Set(delimiters).size).toBe(5);
    expect(output).not.toContain("<<USING_AGORA_OUTPUT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails oversized diffs before invoking reviewers", async () => {
  let reviewed = false;
  const result = await runAction(environment(), {
    readEvent: async () => event,
    getDiff: async () => "x".repeat(200_001),
    getHeadSha: async () => "head-a",
    review: async () => {
      reviewed = true;
      return completedReview;
    },
    createReviewers: () => [],
    reportCheck: async () => {},
    writeOutput: async () => {},
  });

  expect(reviewed).toBe(false);
  expect(result).toMatchObject({
    runStatus: "FAILED",
    verdict: null,
    reason: "Pull request diff exceeds the 200,000 byte review limit",
  });
});

test("reports NEEDS_HUMAN checks with a neutral conclusion", async () => {
  let conclusion: string | undefined;
  const result = await runAction(environment(), {
    readEvent: async () => event,
    getDiff: async () => "diff --git a/a b/a",
    getHeadSha: async () => "head-a",
    review: async () => ({ ...completedReview, verdict: "NEEDS_HUMAN" }),
    createReviewers: () => [],
    reportCheck: async (input) => {
      conclusion = input.conclusion;
    },
    writeOutput: async () => {},
  });

  expect(result.verdict).toBe("NEEDS_HUMAN");
  expect(conclusion).toBe("neutral");
});

test("redacts secrets from Check Run and Action output serialization", async () => {
  const outputs = new Map<string, string>();
  let summary = "";
  const secretFinding: ReviewResult = {
    schemaVersion: 1,
    runStatus: "COMPLETED",
    verdict: "NEEDS_HUMAN",
    reviewedHeadSha: "head-a",
    findings: [
      {
        id: "provider-id",
        title: "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        file: "src/a.ts",
        line: 3,
        severity: "warning",
        evidence:
          "Bearer sk-proj_abcdefghijklmnopqrstuvwxyz and https://user:password@example.test",
        confidence: 0.8,
        whyHumanReview: "api_key: openrouter-secret-value",
      },
    ],
    reason: "authorization=Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  };

  await runAction(environment(), {
    readEvent: async () => event,
    getDiff: async () => "diff --git a/a b/a",
    getHeadSha: async () => "head-a",
    review: async () => secretFinding,
    createReviewers: () => [],
    reportCheck: async (input) => {
      summary = input.output.summary;
    },
    writeOutput: async (name, value) => {
      outputs.set(name, value);
    },
  });

  const serialized = outputs.get("review-result") ?? "";
  expect(summary).toContain("[REDACTED]");
  expect(serialized).toContain("[REDACTED]");
  expect(`${summary}\n${serialized}`).not.toContain(
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  );
  expect(`${summary}\n${serialized}`).not.toContain(
    "sk-proj_abcdefghijklmnopqrstuvwxyz",
  );
  expect(`${summary}\n${serialized}`).not.toContain("user:password@");
});
