import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Pool } from 'pg'

import { SEED_DEVELOPERS, SEED_DEVELOPER_TASK_TYPES, SEED_MANAGEMENT_TASK_TYPES } from './rows'

import type { Lookups } from './rows'

export type TaskTypeCategory = 'developer' | 'management'

// Jira credentials are per user (stored encrypted on login); only the site URL is global
export type Settings = {
  jiraBaseUrl: string
}

export const DEFAULT_SETTINGS: Settings = {
  jiraBaseUrl: process.env.JIRA_BASE_URL ?? 'https://autochek.atlassian.net'
}

const SETTINGS_COLUMNS: Record<keyof Settings, string> = {
  jiraBaseUrl: 'jira_base_url'
}

export type RunRecord = {
  workflowId: string
  sheetUrl: string
  tabId: string
  tabTitle?: string
  parentKey: string
  rowCount: number
  startedAt: string
  actorEmail?: string
}

export type User = {
  email: string
  displayName: string
  accountId: string
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://subtasks:subtasks@localhost:5433/subtasks'
})

export const initDb = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS developers (
      id text PRIMARY KEY,
      name text UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_types (
      id text PRIMARY KEY,
      value text NOT NULL,
      category text NOT NULL CHECK (category IN ('developer', 'management'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      workflow_id text PRIMARY KEY,
      sheet_url text NOT NULL,
      tab_id text NOT NULL,
      parent_key text NOT NULL,
      row_count int NOT NULL,
      started_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      email text PRIMARY KEY,
      display_name text,
      account_id text,
      jira_token_enc text NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY,
      email text NOT NULL,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS breakdowns (
      id text PRIMARY KEY,
      title text NOT NULL,
      description text NOT NULL,
      parent_key text NOT NULL,
      rows jsonb NOT NULL,
      created_by text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS tab_title text;
    ALTER TABLE runs ADD COLUMN IF NOT EXISTS actor_email text;
    ALTER TABLE breakdowns ADD COLUMN IF NOT EXISTS confluence_url text;
  `)

  // One run card per parent issue: keep only the latest run per parent, then enforce it
  await pool.query(`
    DELETE FROM runs a USING runs b
    WHERE a.parent_key = b.parent_key AND a.started_at < b.started_at;
    CREATE UNIQUE INDEX IF NOT EXISTS runs_parent_key_idx ON runs (parent_key);
  `)

  for (const [field, column] of Object.entries(SETTINGS_COLUMNS) as Array<[keyof Settings, string]>) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [column, DEFAULT_SETTINGS[field]])
  }

  // The shared service account (and the removed AI key) are gone — don't keep their secrets around
  await pool.query("DELETE FROM settings WHERE key IN ('jira_email', 'jira_api_key', 'anthropic_api_key')")

  const { rows: [{ count: devCount }] } = await pool.query('SELECT count(*) FROM developers')
  if (+devCount === 0) {
    for (const d of SEED_DEVELOPERS) {
      await pool.query('INSERT INTO developers (id, name) VALUES ($1, $2)', [d.id, d.name])
    }
  }

  const { rows: [{ count: typeCount }] } = await pool.query('SELECT count(*) FROM task_types')
  if (+typeCount === 0) {
    for (const t of SEED_DEVELOPER_TASK_TYPES) {
      await pool.query('INSERT INTO task_types (id, value, category) VALUES ($1, $2, $3)', [t.id, t.value, 'developer'])
    }
    for (const t of SEED_MANAGEMENT_TASK_TYPES) {
      await pool.query('INSERT INTO task_types (id, value, category) VALUES ($1, $2, $3)', [t.id, t.value, 'management'])
    }
  }

  // One-time import of runs recorded before Postgres existed
  const legacyRunsFile = path.join(__dirname, 'runs.json')
  if (fs.existsSync(legacyRunsFile)) {
    const legacy: RunRecord[] = JSON.parse(fs.readFileSync(legacyRunsFile, 'utf-8'))
    for (const r of legacy) {
      await pool.query(
        'INSERT INTO runs (workflow_id, sheet_url, tab_id, parent_key, row_count, started_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
        [r.workflowId, r.sheetUrl, r.tabId, r.parentKey, r.rowCount, r.startedAt]
      )
    }
    fs.renameSync(legacyRunsFile, `${legacyRunsFile}.imported`)
  }
}

// ---------- Settings ----------

// Falls back to defaults so the worker still runs if the table hasn't been created yet
export const getSettings = async (): Promise<Settings> => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings')
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]))

    return {
      jiraBaseUrl: byKey[SETTINGS_COLUMNS.jiraBaseUrl] ?? DEFAULT_SETTINGS.jiraBaseUrl
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export const updateSettings = async (partial: Partial<Settings>): Promise<void> => {
  for (const [field, column] of Object.entries(SETTINGS_COLUMNS) as Array<[keyof Settings, string]>) {
    const value = partial[field]
    if (value !== undefined && value !== '') {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [column, value])
    }
  }
}

// ---------- Lookups ----------

export const getLookups = async (): Promise<Lookups> => {
  const developers = (await pool.query('SELECT id, name FROM developers ORDER BY name')).rows
  const taskTypes = (await pool.query('SELECT id, value, category FROM task_types ORDER BY value')).rows

  return {
    developers,
    developerTaskTypes: taskTypes.filter((t) => t.category === 'developer').map(({ id, value }) => ({ id, value })),
    managementTaskTypes: taskTypes.filter((t) => t.category === 'management').map(({ id, value }) => ({ id, value }))
  }
}

export const upsertDeveloper = async (id: string, name: string, previousId?: string): Promise<void> => {
  if (previousId && previousId !== id) {
    await pool.query('UPDATE developers SET id = $1, name = $2 WHERE id = $3', [id, name, previousId])
  } else {
    await pool.query('INSERT INTO developers (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $2', [id, name])
  }
}

export const deleteDeveloper = async (id: string): Promise<void> => {
  await pool.query('DELETE FROM developers WHERE id = $1', [id])
}

export const upsertTaskType = async (id: string, value: string, category: TaskTypeCategory, previousId?: string): Promise<void> => {
  if (previousId && previousId !== id) {
    await pool.query('UPDATE task_types SET id = $1, value = $2, category = $3 WHERE id = $4', [id, value, category, previousId])
  } else {
    await pool.query(
      'INSERT INTO task_types (id, value, category) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET value = $2, category = $3',
      [id, value, category]
    )
  }
}

export const deleteTaskType = async (id: string): Promise<void> => {
  await pool.query('DELETE FROM task_types WHERE id = $1', [id])
}

// ---------- Runs ----------

// Re-running the same parent issue replaces its run card instead of adding a duplicate
export const saveRun = async (run: RunRecord): Promise<void> => {
  await pool.query(
    `INSERT INTO runs (workflow_id, sheet_url, tab_id, tab_title, parent_key, row_count, started_at, actor_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (parent_key) DO UPDATE SET
       workflow_id = $1, sheet_url = $2, tab_id = $3, tab_title = $4, row_count = $6, started_at = $7, actor_email = $8`,
    [run.workflowId, run.sheetUrl, run.tabId, run.tabTitle ?? '', run.parentKey, run.rowCount, run.startedAt, run.actorEmail ?? '']
  )
}

export const listRuns = async (): Promise<RunRecord[]> => {
  const { rows } = await pool.query('SELECT * FROM runs ORDER BY started_at DESC')
  return rows.map((r) => ({
    workflowId: r.workflow_id,
    sheetUrl: r.sheet_url,
    tabId: r.tab_id,
    tabTitle: r.tab_title ?? '',
    parentKey: r.parent_key,
    rowCount: r.row_count,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
    actorEmail: r.actor_email ?? ''
  }))
}

export const getRun = async (workflowId: string): Promise<RunRecord | undefined> => {
  return (await listRuns()).find((r) => r.workflowId === workflowId)
}

export const deleteRun = async (workflowId: string): Promise<void> => {
  await pool.query('DELETE FROM runs WHERE workflow_id = $1', [workflowId])
}

// ---------- Auth: users, sessions, encrypted per-user Jira tokens ----------

// AES-256-GCM at rest so raw Jira tokens never sit in plaintext in Postgres.
// APP_SECRET should be set in production; the fallback keeps local dev working.
const ENC_KEY = crypto.createHash('sha256').update(process.env.APP_SECRET ?? 'cheat-local-dev-secret').digest()

const encrypt = (plain: string): string => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
}

const decrypt = (stored: string): string => {
  const [iv, tag, enc] = stored.split(':').map((p) => Buffer.from(p, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

export const upsertUser = async (email: string, displayName: string, accountId: string, jiraToken: string): Promise<void> => {
  await pool.query(
    `INSERT INTO users (email, display_name, account_id, jira_token_enc, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email) DO UPDATE SET display_name = $2, account_id = $3, jira_token_enc = $4, updated_at = now()`,
    [email, displayName, accountId, encrypt(jiraToken)]
  )
}

// Decrypted per-user Jira token, used by the worker to act as that person
export const getUserToken = async (email: string): Promise<string | undefined> => {
  const { rows } = await pool.query('SELECT jira_token_enc FROM users WHERE email = $1', [email])
  if (rows.length === 0) return undefined
  try {
    return decrypt(rows[0].jira_token_enc)
  } catch {
    return undefined
  }
}

export const createSession = async (email: string, ttlHours = 24 * 14): Promise<string> => {
  const token = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000)
  await pool.query('INSERT INTO sessions (token, email, created_at, expires_at) VALUES ($1, $2, now(), $3)', [token, email, expires])
  return token
}

// Returns the session's user (identity only, no token) if the session is valid and unexpired
export const getSessionUser = async (token: string | undefined): Promise<User | undefined> => {
  if (!token) return undefined
  const { rows } = await pool.query(
    `SELECT u.email, u.display_name, u.account_id
     FROM sessions s JOIN users u ON u.email = s.email
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  )
  if (rows.length === 0) return undefined
  return { email: rows[0].email, displayName: rows[0].display_name ?? rows[0].email, accountId: rows[0].account_id ?? '' }
}

export const deleteSession = async (token: string): Promise<void> => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token])
}

// ---------- Breakdowns (hand-built or CSV-imported subtask sets) ----------

export type Breakdown = {
  id: string
  title: string
  description: string
  confluenceUrl: string
  parentKey: string
  rows: any[]
  createdBy?: string
  createdAt: string
  updatedAt: string
}

const toBreakdown = (r: any): Breakdown => ({
  id: r.id,
  title: r.title,
  description: r.description,
  confluenceUrl: r.confluence_url ?? '',
  parentKey: r.parent_key,
  rows: r.rows ?? [],
  createdBy: r.created_by ?? '',
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
})

export const saveBreakdown = async (b: Omit<Breakdown, 'createdAt' | 'updatedAt'>): Promise<void> => {
  await pool.query(
    `INSERT INTO breakdowns (id, title, description, confluence_url, parent_key, rows, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (id) DO UPDATE SET title = $2, description = $3, confluence_url = $4, parent_key = $5, rows = $6, updated_at = now()`,
    [b.id, b.title, b.description, b.confluenceUrl ?? '', b.parentKey, JSON.stringify(b.rows), b.createdBy ?? '']
  )
}

export const listBreakdowns = async (): Promise<Breakdown[]> => {
  const { rows } = await pool.query('SELECT * FROM breakdowns ORDER BY updated_at DESC')
  return rows.map(toBreakdown)
}

export const getBreakdown = async (id: string): Promise<Breakdown | undefined> => {
  const { rows } = await pool.query('SELECT * FROM breakdowns WHERE id = $1', [id])
  return rows.length ? toBreakdown(rows[0]) : undefined
}

export const deleteBreakdown = async (id: string): Promise<void> => {
  await pool.query('DELETE FROM breakdowns WHERE id = $1', [id])
}

// email -> display name, for showing who ran each workflow
export const getUserNames = async (): Promise<Record<string, string>> => {
  const { rows } = await pool.query('SELECT email, display_name FROM users')
  return Object.fromEntries(rows.map((r) => [r.email, r.display_name ?? r.email]))
}
