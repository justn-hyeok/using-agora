import type { Finding, Reviewer, ReviewResult } from "@using-agora/contracts";

export type { Finding, Reviewer, ReviewResult } from "@using-agora/contracts";

export interface ParallelReviewInput {
  diff: string;
  headSha: string;
  reviewers: Reviewer[];
}

function isUsableFinding(finding: Finding): boolean {
  return (
    finding.file.trim().length > 0 &&
    Number.isInteger(finding.line) &&
    finding.line > 0 &&
    finding.evidence.trim().length > 0
  );
}

function addedLinesByFile(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let currentFile: Set<number> | undefined;
  let newLine: number | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      const file = path.startsWith("b/") ? path.slice(2) : path;
      currentFile = file === "/dev/null" ? undefined : new Set<number>();
      newLine = undefined;
      if (currentFile !== undefined) {
        files.set(file, currentFile);
      }
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (currentFile === undefined || newLine === undefined) {
      continue;
    }

    if (line.startsWith("+")) {
      currentFile.add(newLine);
      newLine += 1;
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }

  return files;
}

function sameFinding(left: Finding, right: Finding): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.file === right.file &&
    left.line === right.line &&
    left.severity === right.severity &&
    left.evidence === right.evidence &&
    left.confidence === right.confidence &&
    left.whyHumanReview === right.whyHumanReview
  );
}

export async function runParallelReview(
  input: ParallelReviewInput,
): Promise<ReviewResult> {
  if (input.reviewers.length === 0) {
    return {
      schemaVersion: 1,
      runStatus: "FAILED",
      verdict: null,
      reviewedHeadSha: input.headSha,
      findings: [],
      reason: "No reviewers were provided.",
    };
  }

  const addedLines = addedLinesByFile(input.diff);
  const results = await Promise.allSettled(
    input.reviewers.map((reviewer) =>
      Promise.resolve().then(() =>
        reviewer.review({ diff: input.diff, headSha: input.headSha }),
      ),
    ),
  );
  const successful = results.filter(
    (result): result is PromiseFulfilledResult<{ findings: Finding[] }> =>
      result.status === "fulfilled",
  );

  if (successful.length === 0) {
    return {
      schemaVersion: 1,
      runStatus: "FAILED",
      verdict: null,
      reviewedHeadSha: input.headSha,
      findings: [],
      reason: "All reviewers failed.",
    };
  }

  const findingsById = new Map<string, Finding>();
  let hasConflict = false;

  for (const result of successful) {
    for (const finding of result.value.findings) {
      if (
        !isUsableFinding(finding) ||
        !addedLines.get(finding.file)?.has(finding.line)
      ) {
        continue;
      }

      const existing = findingsById.get(finding.id);
      if (existing === undefined) {
        findingsById.set(finding.id, finding);
      } else if (!sameFinding(existing, finding)) {
        hasConflict = true;
      }
    }
  }

  const findings = [...findingsById.values()];
  const hasFailedReviewer = successful.length !== input.reviewers.length;

  if (hasFailedReviewer) {
    return {
      schemaVersion: 1,
      runStatus: "COMPLETED",
      verdict: "NEEDS_HUMAN",
      reviewedHeadSha: input.headSha,
      findings,
      reason: "One or more reviewers failed.",
    };
  }

  if (hasConflict) {
    return {
      schemaVersion: 1,
      runStatus: "COMPLETED",
      verdict: "NEEDS_HUMAN",
      reviewedHeadSha: input.headSha,
      findings,
      reason: "Reviewers disagreed about one or more findings.",
    };
  }

  if (findings.some((finding) => finding.severity === "critical")) {
    return {
      schemaVersion: 1,
      runStatus: "COMPLETED",
      verdict: "BLOCK",
      reviewedHeadSha: input.headSha,
      findings,
    };
  }

  if (findings.length > 0) {
    return {
      schemaVersion: 1,
      runStatus: "COMPLETED",
      verdict: "NEEDS_HUMAN",
      reviewedHeadSha: input.headSha,
      findings,
      reason: "Reviewers reported warning findings.",
    };
  }

  return {
    schemaVersion: 1,
    runStatus: "COMPLETED",
    verdict: "PASS",
    reviewedHeadSha: input.headSha,
    findings: [],
  };
}
