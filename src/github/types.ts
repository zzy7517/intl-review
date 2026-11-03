export type PullRequest = {
  number: number
  title: string
  headSha: string
  baseRef: string
  createdAt: string
}

export type PullDiff = {
  diff: string
  omittedFiles: string[]
}

export interface Github {
  getPullDiff(repo: string, number: number): Promise<PullDiff>
  hasReviewMarker(repo: string, number: number, marker: string): Promise<boolean>
  createReviewComment(repo: string, number: number, headSha: string, body: string): Promise<void>
  startCheckRun(repo: string, headSha: string): Promise<number>
  finishCheckRun(
    repo: string,
    checkRunId: number,
    conclusion: CheckConclusion,
    title: string,
    summary: string,
  ): Promise<void>
}

export type CheckConclusion = "success" | "failure" | "neutral"
