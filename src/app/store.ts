import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export type ReviewStatus = "received" | "done" | "skipped" | "failed"

export type ReviewRow = {
  repo: string
  prNumber: number
  headSha: string
  baseRef: string
  status: ReviewStatus
  report: string
  lastError: string
  updatedAt: string
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  begin(input: { repo: string; prNumber: number; headSha: string; baseRef: string }): "run" | "skip" {
    const existing = this.get(input.repo, input.prNumber, input.headSha)
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO reviews (repo, pr_number, head_sha, base_ref, status, updated_at)
           VALUES (?, ?, ?, ?, 'received', ?)`,
        )
        .run(input.repo, input.prNumber, input.headSha, input.baseRef, now())
      return "run"
    }
    if (existing.status === "received") return "run"
    return "skip"
  }

  finish(
    repo: string,
    prNumber: number,
    headSha: string,
    status: Exclude<ReviewStatus, "received">,
    report: string,
    lastError = "",
  ): void {
    this.db
      .prepare(
        `UPDATE reviews
         SET status=?, report=?, last_error=?, updated_at=?
         WHERE repo=? AND pr_number=? AND head_sha=?`,
      )
      .run(status, report, lastError, now(), repo, prNumber, headSha)
  }

  listReceived(): ReviewRow[] {
    const rows = this.db
      .prepare(
        `SELECT repo, pr_number, head_sha, base_ref, status, report, last_error, updated_at
         FROM reviews WHERE status='received' ORDER BY id ASC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map(toRow)
  }

  list(limit: number): ReviewRow[] {
    const rows = this.db
      .prepare(
        `SELECT repo, pr_number, head_sha, base_ref, status, report, last_error, updated_at
         FROM reviews ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[]
    return rows.map(toRow)
  }

  private get(repo: string, prNumber: number, headSha: string): ReviewRow | undefined {
    const row = this.db
      .prepare(
        `SELECT repo, pr_number, head_sha, base_ref, status, report, last_error, updated_at
         FROM reviews WHERE repo=? AND pr_number=? AND head_sha=?`,
      )
      .get(repo, prNumber, headSha) as Record<string, unknown> | undefined
    return row ? toRow(row) : undefined
  }
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      report TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE (repo, pr_number, head_sha)
    );
  `)
  return new Store(db)
}

function toRow(row: Record<string, unknown>): ReviewRow {
  return {
    repo: String(row.repo),
    prNumber: Number(row.pr_number),
    headSha: String(row.head_sha),
    baseRef: String(row.base_ref),
    status: String(row.status) as ReviewStatus,
    report: String(row.report ?? ""),
    lastError: String(row.last_error ?? ""),
    updatedAt: String(row.updated_at),
  }
}

function now(): string {
  return new Date().toISOString()
}
