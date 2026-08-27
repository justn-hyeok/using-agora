export type RunStatus = "COMPLETED" | "FAILED" | "STALE" | "SKIPPED";

export type ReviewVerdict = "PASS" | "NEEDS_HUMAN" | "BLOCK";

export interface Finding {
  id: string;
  title: string;
  file: string;
  line: number;
  severity: "warning" | "critical";
  evidence: string;
  confidence: number;
  whyHumanReview?: string;
}

export interface ReviewResult {
  schemaVersion: 1;
  runStatus: RunStatus;
  verdict: ReviewVerdict | null;
  reviewedHeadSha: string;
  findings: Finding[];
  reason?: string;
}

export interface Reviewer {
  id: string;
  review(input: {
    diff: string;
    headSha: string;
  }): Promise<{ findings: Finding[] }>;
}

const runStatuses = new Set<RunStatus>([
  "COMPLETED",
  "FAILED",
  "STALE",
  "SKIPPED",
]);

const reviewVerdicts = new Set<ReviewVerdict>(["PASS", "NEEDS_HUMAN", "BLOCK"]);

const severities = new Set<Finding["severity"]>(["warning", "critical"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFinding(value: unknown): value is Finding {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.file === "string" &&
    typeof value.line === "number" &&
    Number.isFinite(value.line) &&
    typeof value.severity === "string" &&
    severities.has(value.severity as Finding["severity"]) &&
    typeof value.evidence === "string" &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    (value.whyHumanReview === undefined ||
      typeof value.whyHumanReview === "string")
  );
}

export function isReviewResult(value: unknown): value is ReviewResult {
  if (!isRecord(value)) {
    return false;
  }

  const hasValidVerdict =
    value.verdict === null ||
    (typeof value.verdict === "string" &&
      reviewVerdicts.has(value.verdict as ReviewVerdict));
  const statusAllowsVerdict = value.runStatus !== "SKIPPED";
  const passHasCompletedRun =
    value.verdict !== "PASS" ||
    value.runStatus === "COMPLETED" ||
    value.runStatus === "STALE" ||
    value.runStatus === "FAILED";

  return (
    value.schemaVersion === 1 &&
    typeof value.runStatus === "string" &&
    runStatuses.has(value.runStatus as RunStatus) &&
    hasValidVerdict &&
    (statusAllowsVerdict || value.verdict === null) &&
    passHasCompletedRun &&
    typeof value.reviewedHeadSha === "string" &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

export function assertReviewResult(
  value: unknown,
): asserts value is ReviewResult {
  if (!isReviewResult(value)) {
    throw new TypeError("Expected a valid ReviewResult.");
  }
}
