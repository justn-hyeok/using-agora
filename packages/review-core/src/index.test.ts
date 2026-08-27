import { describe, expect, test } from "bun:test";

import {
  type Finding,
  isReviewResult,
  type Reviewer,
} from "@using-agora/contracts";

import { runParallelReview } from "./index";

const headSha = "abc123";
const diff = [
  "diff --git a/src/file.ts b/src/file.ts",
  "index 1111111..2222222 100644",
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -10,2 +10,3 @@",
  " const unchanged = true;",
  "+const added = true;",
  "+const addedAgain = true;",
  " const retained = true;",
].join("\n");

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    title: "An issue",
    file: "src/file.ts",
    line: 12,
    severity: "warning",
    evidence: "The changed code demonstrates the issue.",
    confidence: 0.9,
    ...overrides,
  };
}

function reviewer(findings: Finding[]): Reviewer {
  return {
    id: crypto.randomUUID(),
    review: async () => ({ findings }),
  };
}

function failedReviewer(): Reviewer {
  return {
    id: crypto.randomUUID(),
    review: async () => {
      throw new Error("reviewer unavailable");
    },
  };
}

describe("runParallelReview", () => {
  test("returns PASS when all reviewers succeed without findings", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [reviewer([]), reviewer([])],
    });

    expect(result).toMatchObject({
      runStatus: "COMPLETED",
      verdict: "PASS",
      reviewedHeadSha: headSha,
      findings: [],
    });
  });

  test("returns BLOCK for a valid critical finding", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [reviewer([finding({ severity: "critical" })])],
    });

    expect(result.verdict).toBe("BLOCK");
  });

  test("hands conflicting duplicate findings to a human", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [
        reviewer([finding()]),
        reviewer([finding({ severity: "critical" })]),
      ],
    });

    expect(result.verdict).toBe("NEEDS_HUMAN");
    expect(result.reason).toContain("disagreed");
  });

  test("hands partial reviewer failure to a human", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [reviewer([]), failedReviewer()],
    });

    expect(result.verdict).toBe("NEEDS_HUMAN");
    expect(result.reason).toContain("failed");
  });

  test("returns FAILED when every reviewer fails", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [failedReviewer(), failedReviewer()],
    });

    expect(result).toMatchObject({
      runStatus: "FAILED",
      verdict: null,
      findings: [],
    });
  });

  test("deduplicates identical findings by stable id", async () => {
    const duplicate = finding();
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [reviewer([duplicate]), reviewer([{ ...duplicate }])],
    });

    expect(result.findings).toEqual([duplicate]);
    expect(result.verdict).toBe("NEEDS_HUMAN");
  });

  test("filters findings without usable evidence", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [
        reviewer([
          finding({ id: "empty-file", file: " " }),
          finding({ id: "zero-line", line: 0 }),
          finding({ id: "missing-evidence", evidence: "" }),
        ]),
      ],
    });

    expect(result).toMatchObject({
      verdict: "PASS",
      findings: [],
    });
  });

  test("returns FAILED when no reviewers are provided", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [],
    });

    expect(result).toMatchObject({
      runStatus: "FAILED",
      verdict: null,
      findings: [],
    });
  });

  test("filters findings outside added diff lines", async () => {
    const result = await runParallelReview({
      diff,
      headSha,
      reviewers: [
        reviewer([
          finding({ id: "unchanged-line", line: 10 }),
          finding({ id: "missing-file", file: "src/other.ts", line: 11 }),
          finding({ id: "added-line", line: 11 }),
        ]),
      ],
    });

    expect(result.findings).toEqual([finding({ id: "added-line", line: 11 })]);
  });

  test("enforces confidence bounds and review-result status invariants", () => {
    const valid = {
      schemaVersion: 1 as const,
      runStatus: "COMPLETED" as const,
      verdict: "PASS" as const,
      reviewedHeadSha: headSha,
      findings: [finding({ confidence: 0 })],
    };

    expect(isReviewResult(valid)).toBe(true);
    expect(
      isReviewResult({
        ...valid,
        findings: [finding({ confidence: 1 })],
      }),
    ).toBe(true);
    expect(
      isReviewResult({
        ...valid,
        findings: [finding({ confidence: -0.01 })],
      }),
    ).toBe(false);
    expect(
      isReviewResult({
        ...valid,
        findings: [finding({ confidence: 1.01 })],
      }),
    ).toBe(false);
    expect(isReviewResult({ ...valid, runStatus: "STALE" })).toBe(true);
    expect(
      isReviewResult({ ...valid, runStatus: "FAILED", verdict: "BLOCK" }),
    ).toBe(true);
    expect(
      isReviewResult({ ...valid, runStatus: "SKIPPED", verdict: "PASS" }),
    ).toBe(false);
    expect(
      isReviewResult({ ...valid, runStatus: "STALE", verdict: "BLOCK" }),
    ).toBe(true);
  });
});
