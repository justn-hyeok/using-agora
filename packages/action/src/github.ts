export interface PullRequestRef {
  owner: string;
  repository: string;
  number: number;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
}

export interface CheckRun {
  id: number;
  name: string;
}

const githubApiUrl = (pullRequest: PullRequestRef, path: string): string =>
  `https://api.github.com/repos/${pullRequest.owner}/${pullRequest.repository}${path}`;

const githubHeaders = (
  token: string,
  accept = "application/vnd.github+json",
): HeadersInit => ({
  Accept: accept,
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

async function requestGithub(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }

  return response;
}

export async function getPullRequestDiff(
  pullRequest: PullRequestRef,
  token: string,
): Promise<string> {
  const response = await requestGithub(
    token,
    githubApiUrl(pullRequest, `/pulls/${pullRequest.number}`),
    { headers: githubHeaders(token, "application/vnd.github.diff") },
  );
  return response.text();
}

export async function getCurrentHeadSha(
  pullRequest: PullRequestRef,
  token: string,
): Promise<string> {
  const response = await requestGithub(
    token,
    githubApiUrl(pullRequest, `/pulls/${pullRequest.number}`),
  );
  const payload: unknown = await response.json();
  const headSha = (payload as { head?: { sha?: unknown } }).head?.sha;
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error("GitHub pull request response did not include head.sha");
  }
  return headSha;
}

export async function upsertCheckRun(input: {
  pullRequest: PullRequestRef;
  token: string;
  headSha: string;
  conclusion: "success" | "failure" | "neutral";
  output: CheckRunOutput;
}): Promise<void> {
  const checksUrl = githubApiUrl(
    input.pullRequest,
    `/commits/${input.headSha}/check-runs?check_name=using-agora`,
  );
  const existingResponse = await requestGithub(input.token, checksUrl);
  const existingPayload: unknown = await existingResponse.json();
  const checkRuns = (existingPayload as { check_runs?: unknown }).check_runs;
  const existing = Array.isArray(checkRuns)
    ? checkRuns.find(
        (value): value is CheckRun =>
          typeof value === "object" &&
          value !== null &&
          (value as CheckRun).name === "using-agora" &&
          typeof (value as CheckRun).id === "number",
      )
    : undefined;
  const body = JSON.stringify({
    name: "using-agora",
    status: "completed",
    conclusion: input.conclusion,
    completed_at: new Date().toISOString(),
    output: input.output,
  });

  if (existing) {
    await requestGithub(
      input.token,
      githubApiUrl(input.pullRequest, `/check-runs/${existing.id}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    return;
  }

  await requestGithub(
    input.token,
    githubApiUrl(input.pullRequest, "/check-runs"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(body), head_sha: input.headSha }),
    },
  );
}
