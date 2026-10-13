import { Client, Connection } from '@temporalio/client'
import axios from 'axios'
import express from 'express'
import * as crypto from 'node:crypto'
import * as path from 'node:path'

import {
  FIELD_DEV_SUBTASK_TYPE, FIELD_DEVELOPER, FIELD_END_DATE,
  FIELD_ESTIMATED_HOURS, FIELD_MGMT_SUBTASK_TYPE, FIELD_START_DATE, PROJECT_ID
} from './activities'
import * as db from './db'
import { buildRowsFromRecords, parseCsvRecords } from './rows'
import { TEMPORAL_NAMESPACE, temporalConnectionOptions } from './temporal'
import { processSheet, progressQuery } from './workflows'

import type { Lookups } from './rows'
import type { Row } from './types'
import type { RowStatus, SheetRunInput } from './workflows'

const TEMPORAL_TASK_QUEUE_NAME = 'subtask-processing'
const PORT = +(process.env.PORT ?? 3456)

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/i

// Normalize for comparing breakdown summaries against Jira subtask titles
const normalizeSummary = (s: string): string => s.trim().replace(/\.+$/, '').toLowerCase()

// Jira REST base + auth, always as the logged-in user with their own token
const jiraApi = async (actorEmail?: string) => {
  const settings = await db.getSettings()
  const base = `${settings.jiraBaseUrl.replace(/\/+$/, '')}/rest/api/3`

  const token = actorEmail ? await db.getUserToken(actorEmail) : undefined
  if (!actorEmail || !token) {
    throw Object.assign(new Error('Your Jira token is missing — sign out and sign in again'), { status: 401 })
  }
  return { base, auth: { username: actorEmail, password: token } }
}

// Ask Jira which subtasks the parent already has, so re-runs update them instead of duplicating.
// Also validates that the parent issue actually exists.
const fetchExistingSubtasks = async (parentKey: string, actorEmail?: string): Promise<Array<{ issueKey: string, summary: string }>> => {
  const { base, auth } = await jiraApi(actorEmail)
  const response = await axios.get(
    `${base}/issue/${parentKey}?fields=subtasks`,
    { auth, validateStatus: () => true }
  )

  if (response.status === 404) {
    throw Object.assign(new Error(`Parent issue ${parentKey} was not found in Jira`), { status: 400 })
  }
  if (response.status !== 200) {
    // Auth/permission hiccups shouldn't block a run — worst case rows are skipped later by Temporal dedupe
    return []
  }

  return (response.data?.fields?.subtasks ?? []).map((t: any) => ({
    issueKey: String(t.key ?? ''),
    summary: String(t.fields?.summary ?? '')
  }))
}

// Cached summary -> issue key map per parent, for filling in keys on rows that were
// skipped before we knew them (e.g. "already created in a previous run")
const subtaskKeyCache = new Map<string, { at: number, bySummary: Map<string, string> }>()

const getSubtaskKeyMap = async (parentKey: string, actorEmail?: string): Promise<Map<string, string>> => {
  const cached = subtaskKeyCache.get(parentKey)
  if (cached && Date.now() - cached.at < 30_000) return cached.bySummary

  const bySummary = new Map<string, string>()
  for (const t of await fetchExistingSubtasks(parentKey, actorEmail)) {
    if (!bySummary.has(normalizeSummary(t.summary))) bySummary.set(normalizeSummary(t.summary), t.issueKey)
  }

  subtaskKeyCache.set(parentKey, { at: Date.now(), bySummary })
  return bySummary
}

const assertIssueKey = (parentKey: unknown): string => {
  if (!parentKey || !ISSUE_KEY_PATTERN.test(String(parentKey).trim())) {
    throw Object.assign(new Error(`"${parentKey ?? ''}" doesn't look like a Jira issue key (expected e.g. AET-123)`), { status: 400 })
  }
  return String(parentKey).trim().toUpperCase()
}

// Split built rows into ones that already exist as subtasks of the parent (matched by an
// explicit Jira key, then by summary) and ones still to create. Existing ones are left alone.
// otherSubtasks = Jira subtasks under the parent that no row corresponds to.
const findInJira = async (rows: Row[], key: string, actorEmail?: string) => {
  const subtasks = await fetchExistingSubtasks(key, actorEmail)
  const validKeys = new Set(subtasks.map((t) => t.issueKey))

  const bySummary = new Map<string, string>()
  for (const t of subtasks) {
    if (!bySummary.has(normalizeSummary(t.summary))) bySummary.set(normalizeSummary(t.summary), t.issueKey)
  }

  const existing: Array<{ summary: string, issueKey: string }> = []
  const toCreate: Row[] = []
  for (const row of rows) {
    const issueKey = (row.issue_id && validKeys.has(row.issue_id))
      ? row.issue_id
      : bySummary.get(normalizeSummary(row.summary))
    if (issueKey) existing.push({ summary: row.summary, issueKey })
    else toCreate.push(row)
  }

  const matchedKeys = new Set(existing.map((e) => e.issueKey))
  const otherSubtasks = subtasks.filter((t) => !matchedKeys.has(t.issueKey))

  return { existing, toCreate, otherSubtasks }
}

const errorResponse = (res: express.Response, err: unknown) => {
  const status = (err as any)?.status ?? 500
  res.status(status).json({ errors: (err as any)?.errors ?? [err instanceof Error ? err.message : String(err)] })
}

const run = async () => {
  await db.initDb()

  const connection = await Connection.connect(temporalConnectionOptions)
  const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE })

  const app = express()
  // Behind Caddy in production: trust its X-Forwarded-Proto so req.secure reflects HTTPS
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1)
  app.use(express.json())
  app.use(express.static(path.join(__dirname, 'public')))

  // ---------- Auth ----------

  const SESSION_COOKIE = 'cheat_session'
  const ALLOWED_DOMAIN = '@autochek.africa'

  const readCookie = (req: express.Request, name: string): string | undefined => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (k === name) return decodeURIComponent(v.join('='))
    }
    return undefined
  }

  const actorOf = (req: express.Request): string => (req as any).user.email

  app.post('/api/login', async (req, res) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase()
      const apiToken = String(req.body?.apiToken ?? '').trim()

      if (!email || !apiToken) {
        return res.status(400).json({ errors: ['Email and Jira API token are required'] })
      }
      if (!email.endsWith(ALLOWED_DOMAIN)) {
        return res.status(403).json({ errors: [`Only ${ALLOWED_DOMAIN} emails can sign in`] })
      }

      // The token validates the login: it must authenticate against Jira as this exact person
      const settings = await db.getSettings()
      const base = `${settings.jiraBaseUrl.replace(/\/+$/, '')}/rest/api/3`
      const resp = await axios.get(`${base}/myself`, { auth: { username: email, password: apiToken }, validateStatus: () => true })

      if (resp.status === 401 || resp.status === 403) {
        return res.status(401).json({ errors: ['Jira rejected that email + API token. Double-check your token at id.atlassian.com.'] })
      }
      if (resp.status !== 200) {
        return res.status(502).json({ errors: [`Could not reach Jira to verify (status ${resp.status})`] })
      }

      const accountEmail = String(resp.data?.emailAddress ?? '').toLowerCase()
      if (accountEmail && accountEmail !== email) {
        return res.status(403).json({ errors: [`That token belongs to ${accountEmail}, not ${email}`] })
      }

      await db.upsertUser(email, String(resp.data?.displayName ?? email), String(resp.data?.accountId ?? ''), apiToken)
      const token = await db.createSession(email)
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 14 * 24 * 3600 * 1000 })
      res.json({ user: { email, displayName: resp.data?.displayName ?? email, accountId: resp.data?.accountId ?? '' } })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.get('/api/me', async (req, res) => {
    const user = await db.getSessionUser(readCookie(req, SESSION_COOKIE))
    if (!user) return res.status(401).json({ errors: ['Not signed in'] })
    res.json({ user })
  })

  app.post('/api/logout', async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE)
    if (token) await db.deleteSession(token)
    res.clearCookie(SESSION_COOKIE)
    res.json({ ok: true })
  })

  // Everything else under /api requires a valid session
  app.use('/api', async (req, res, next) => {
    try {
      const user = await db.getSessionUser(readCookie(req, SESSION_COOKIE))
      if (!user) return res.status(401).json({ errors: ['Not signed in'] })
      ;(req as any).user = user
      next()
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // ---------- Runs ----------

  // Start a processSheet workflow for a breakdown and record it
  const startRun = async (opts: {
    rows: Row[]
    key: string
    actorEmail: string
    sheetUrl: string
    tabId: string
    tabTitle: string
    alreadyInJira: Array<{ summary: string, issueKey: string }>
  }): Promise<string> => {
    const workflowId = `sheet-run-${opts.key.toLowerCase()}-${Date.now()}`
    const input: SheetRunInput = {
      rows: opts.rows,
      parentKey: opts.key,
      sheetUrl: opts.sheetUrl,
      alreadyInJira: opts.alreadyInJira,
      // Same list again under the older field, so a worker still running pre-alreadyInJira code
      // skips these too instead of creating duplicates
      unchangedIssues: opts.alreadyInJira,
      actorEmail: opts.actorEmail
    }

    await client.workflow.start(processSheet, {
      args: [input],
      workflowId,
      staticDetails: `${opts.key}: ${opts.rows.length} subtasks`,
      taskQueue: TEMPORAL_TASK_QUEUE_NAME
    })

    await db.saveRun({
      workflowId,
      sheetUrl: opts.sheetUrl,
      tabId: opts.tabId,
      tabTitle: opts.tabTitle,
      parentKey: opts.key,
      rowCount: opts.rows.length,
      startedAt: new Date().toISOString(),
      actorEmail: opts.actorEmail
    })

    return workflowId
  }

  app.get('/api/runs', async (_req, res) => {
    try {
      const runs = await db.listRuns()
      const names = await db.getUserNames()

      const withStatus = await Promise.all(runs.map(async (r) => {
        const actorName = r.actorEmail ? (names[r.actorEmail] ?? r.actorEmail) : ''
        try {
          const description = await client.workflow.getHandle(r.workflowId).describe()
          return { ...r, actorName, status: description.status.name }
        } catch {
          return { ...r, actorName, status: 'UNKNOWN' }
        }
      }))

      res.json(withStatus)
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.get('/api/runs/:workflowId', async (req, res) => {
    try {
      const record = await db.getRun(req.params.workflowId)
      if (!record) {
        return res.status(404).json({ errors: ['Run not found'] })
      }

      const handle = client.workflow.getHandle(record.workflowId)

      let status = 'UNKNOWN'
      let failure: string | undefined
      try {
        const description = await handle.describe()
        status = description.status.name
      } catch {}

      let progress: RowStatus[] = []
      try {
        progress = await handle.query(progressQuery)
      } catch (err) {
        // Query needs a running worker; surface that instead of an empty page
        failure = `Could not fetch row progress (is the worker running?): ${err instanceof Error ? err.message : String(err)}`
      }

      // Progress rows carry the Jira account id — resolve to the developer's name for display
      const lookups = await db.getLookups()
      let enriched = progress.map((p) => ({
        ...p,
        developer: lookups.developers.find((d) => d.id === p.developer)?.name ?? p.developer
      }))

      // Rows skipped by Temporal dedupe never learned their Jira key — fill it from Jira itself
      if (enriched.some((p) => !p.issueKey && p.status === 'skipped')) {
        try {
          const keyMap = await getSubtaskKeyMap(record.parentKey, actorOf(req))
          enriched = enriched.map((p) => p.issueKey ? p : { ...p, issueKey: keyMap.get(normalizeSummary(p.summary)) })
        } catch {
          // Display enrichment only — never fail the endpoint over it
        }
      }

      // Subtasks in Jira that no progress row covers — leftovers from renames/removals
      let orphans: Array<{ issueKey: string, summary: string }> = []
      try {
        // Match by key; fall back to summary only for rows that never learned their key, so an
        // older duplicate with the same title still shows up here instead of being hidden
        const progressKeys = new Set(enriched.map((p) => p.issueKey).filter(Boolean))
        const progressSummaries = new Set(enriched.filter((p) => !p.issueKey).map((p) => normalizeSummary(p.summary)))
        orphans = (await fetchExistingSubtasks(record.parentKey, actorOf(req)))
          .filter((t) => !progressKeys.has(t.issueKey) && !progressSummaries.has(normalizeSummary(t.summary)))
      } catch {}

      const names = await db.getUserNames()
      const actorName = record.actorEmail ? (names[record.actorEmail] ?? record.actorEmail) : ''

      // Breakdown runs store the breakdown id as tabId (older runs stored the literal "breakdown")
      const breakdownLink = !record.sheetUrl && record.tabId !== 'breakdown' && await db.getBreakdown(record.tabId)
        ? `#breakdown/${record.tabId}`
        : ''

      res.json({ ...record, actorName, status, progress: enriched, failure, orphans, breakdownLink })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.delete('/api/runs/:workflowId', async (req, res) => {
    try {
      const record = await db.getRun(req.params.workflowId)
      if (!record) {
        return res.status(404).json({ errors: ['Run not found'] })
      }

      // Stop the workflow if it's still going, then drop the record
      try {
        const description = await client.workflow.getHandle(record.workflowId).describe()
        if (description.status.name === 'RUNNING') {
          await client.workflow.getHandle(record.workflowId).terminate('Deleted from the UI')
        }
      } catch {}

      await db.deleteRun(record.workflowId)
      res.json({ ok: true })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // ---------- Breakdowns ----------

  // Parse an uploaded CSV (same columns as the sheet template) into editable breakdown rows
  app.post('/api/breakdowns/parse-csv', async (req, res) => {
    try {
      const csv = String(req.body?.csv ?? '')
      if (!csv.trim()) {
        return res.status(400).json({ errors: ['The CSV file is empty'] })
      }
      const rows = parseCsvRecords(csv)
      if (rows.length === 0) {
        return res.status(400).json({ errors: ['The CSV has a header but no data rows'] })
      }
      if (!rows.some((r) => r.summary)) {
        return res.status(400).json({ errors: ['No "summary" column found — the first row must be the template headers'] })
      }
      res.json({ rows })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // Local validation only (no Jira round trip) — drives live errors in the editor
  app.post('/api/breakdowns/validate', async (req, res) => {
    try {
      const key = assertIssueKey(req.body?.parentKey)
      const lookups = await db.getLookups()
      const { errors } = buildRowsFromRecords(req.body?.rows ?? [], key, lookups)
      res.json({ errors })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.get('/api/breakdowns', async (_req, res) => {
    try {
      const [breakdowns, names] = await Promise.all([db.listBreakdowns(), db.getUserNames()])
      res.json(breakdowns.map((b) => ({
        ...b,
        rowCount: b.rows.length,
        rows: undefined,
        authorName: b.createdBy ? (names[b.createdBy] ?? b.createdBy) : ''
      })))
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.get('/api/breakdowns/:id', async (req, res) => {
    try {
      const breakdown = await db.getBreakdown(req.params.id)
      if (!breakdown) return res.status(404).json({ errors: ['Breakdown not found'] })

      const names = await db.getUserNames()
      res.json({ ...breakdown, authorName: breakdown.createdBy ? (names[breakdown.createdBy] ?? breakdown.createdBy) : '' })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.post('/api/breakdowns', async (req, res) => {
    try {
      const { id, title, description, confluenceUrl, parentKey, rows } = req.body ?? {}
      if (!String(title ?? '').trim()) {
        return res.status(400).json({ errors: ['Give the breakdown a title'] })
      }

      const breakdownId = String(id ?? '').trim() || crypto.randomUUID()
      const existing = id ? await db.getBreakdown(breakdownId) : undefined

      await db.saveBreakdown({
        id: breakdownId,
        title: String(title).trim(),
        description: String(description ?? ''),
        confluenceUrl: String(confluenceUrl ?? '').trim(),
        parentKey: String(parentKey ?? '').trim().toUpperCase(),
        rows: Array.isArray(rows) ? rows : [],
        // Keep the original author when editing someone else's breakdown
        createdBy: existing?.createdBy || actorOf(req)
      })

      res.json({ id: breakdownId })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.delete('/api/breakdowns/:id', async (req, res) => {
    try {
      await db.deleteBreakdown(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // Validate a saved breakdown and split its rows into "already in Jira" vs "to create"
  const prepareBreakdown = async (id: string, actorEmail: string) => {
    const breakdown = await db.getBreakdown(id)
    if (!breakdown) throw Object.assign(new Error('Breakdown not found'), { status: 404 })

    // Drafts may be saved without these, but a workflow needs both
    const missing = [
      ...(breakdown.parentKey ? [] : ['Add the parent issue key before creating subtasks']),
      ...(/^https?:\/\/\S+$/i.test(breakdown.confluenceUrl) ? [] : ['Add a valid Confluence link (https://...) before creating subtasks'])
    ]
    if (missing.length > 0) throw Object.assign(new Error(missing.join('. ')), { status: 400, errors: missing })

    const key = assertIssueKey(breakdown.parentKey)
    const lookups = await db.getLookups()
    const { rows, errors } = buildRowsFromRecords(breakdown.rows, key, lookups)
    if (errors.length > 0) throw Object.assign(new Error(errors[0]), { status: 400, errors })

    return { breakdown, key, rows, ...(await findInJira(rows, key, actorEmail)) }
  }

  // What "Create" would do: which tasks already exist under the parent, which are new
  app.post('/api/breakdowns/:id/preview', async (req, res) => {
    try {
      const { key, existing, toCreate, otherSubtasks } = await prepareBreakdown(req.params.id, actorOf(req))
      res.json({ parentKey: key, existing, toCreate: toCreate.map((r) => r.summary), otherSubtasks })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // Create only the tasks that aren't in Jira yet; existing ones are listed on the run, untouched
  app.post('/api/breakdowns/:id/create', async (req, res) => {
    try {
      const actorEmail = actorOf(req)
      // Runs even when nothing is new, so the run page still lists every task with its Jira key
      const { breakdown, key, rows, existing } = await prepareBreakdown(req.params.id, actorEmail)

      const workflowId = await startRun({
        rows, key, actorEmail,
        sheetUrl: '',
        // The run remembers which breakdown it came from
        tabId: breakdown.id,
        tabTitle: breakdown.title,
        alreadyInJira: existing
      })

      res.json({ workflowId })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // ---------- Health ----------

  app.get('/api/health', async (_req, res) => {
    let workerOnline = false
    try {
      const described = await connection.workflowService.describeTaskQueue({
        namespace: TEMPORAL_NAMESPACE,
        taskQueue: { name: TEMPORAL_TASK_QUEUE_NAME },
        taskQueueType: 1 // workflow task queue
      })
      workerOnline = (described.pollers?.length ?? 0) > 0
    } catch {}
    res.json({ workerOnline })
  })

  // ---------- Lookup sync from Jira ----------

  // Sync one lookup table (target) from Jira, or all three when target is omitted
  app.post('/api/lookups/sync', async (req, res) => {
    try {
      const target = req.body?.target as 'developers' | 'developerTaskTypes' | 'managementTaskTypes' | undefined
      const { base, auth } = await jiraApi(actorOf(req))
      const result = { developers: 0, developerTaskTypes: 0, managementTaskTypes: 0, warnings: [] as string[] }

      // People assignable to the project = the developer list
      const syncDevelopers = async () => {
        try {
          const users = await axios.get(`${base}/user/assignable/search?project=${PROJECT_ID}&maxResults=200`, { auth })
          for (const u of users.data ?? []) {
            if (u.accountType !== 'atlassian' || !u.accountId || !u.displayName) continue
            try {
              await db.upsertDeveloper(u.accountId, u.displayName)
              result.developers++
            } catch { /* duplicate names — keep the existing entry */ }
          }
        } catch (err) {
          result.warnings.push(`Developers: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Task types come from the custom fields' option lists (needs Jira admin permission)
      const syncFieldOptions = async (fieldId: string, category: 'developer' | 'management', counter: 'developerTaskTypes' | 'managementTaskTypes') => {
        try {
          const contexts = await axios.get(`${base}/field/${fieldId}/context`, { auth })
          const contextId = contexts.data?.values?.[0]?.id
          if (!contextId) throw new Error('no field context found')

          const options = await axios.get(`${base}/field/${fieldId}/context/${contextId}/option?maxResults=200`, { auth })
          for (const o of options.data?.values ?? []) {
            await db.upsertTaskType(String(o.id), String(o.value), category)
            result[counter]++
          }
        } catch (err) {
          const status = axios.isAxiosError(err) ? err.response?.status : undefined
          result.warnings.push(
            status === 403
              ? `${category} task types: your Jira account lacks admin permission to read field options — manage these manually`
              : `${category} task types: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      if (!target || target === 'developers') await syncDevelopers()
      if (!target || target === 'developerTaskTypes') await syncFieldOptions(FIELD_DEV_SUBTASK_TYPE, 'developer', 'developerTaskTypes')
      if (!target || target === 'managementTaskTypes') await syncFieldOptions(FIELD_MGMT_SUBTASK_TYPE, 'management', 'managementTaskTypes')

      res.json(result)
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // ---------- Settings ----------

  app.get('/api/settings', async (_req, res) => {
    try {
      const s = await db.getSettings()
      res.json({
        jiraBaseUrl: s.jiraBaseUrl
      })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.post('/api/settings', async (req, res) => {
    try {
      const { jiraBaseUrl } = req.body ?? {}

      if (jiraBaseUrl && !/^https:\/\/.+/.test(String(jiraBaseUrl).trim())) {
        return res.status(400).json({ errors: ['Jira base URL must start with https://'] })
      }

      await db.updateSettings({
        jiraBaseUrl: jiraBaseUrl?.trim()
      })
      res.json({ ok: true })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // ---------- Lookup tables ----------

  app.get('/api/lookups', async (_req, res) => {
    try {
      res.json(await db.getLookups())
    } catch (err) {
      errorResponse(res, err)
    }
  })

  // Downloadable CSV template, pre-filled with valid example rows from the current lookups
  app.get('/api/template.csv', async (_req, res) => {
    try {
      // Placeholder values only — real developer names and task types live in Settings
      const header = ['id', 'summary', 'description', 'task_type', 'sub_task_type', 'developer', 'label', 'estimated_hours', 'start_date', 'end_date', 'due_date']
      const quote = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
      const rows = [
        ['', 'Example developer task — replace me', 'What needs doing and how to know it is done', 'Developer Task', 'A developer task type from Settings', 'Developer name from Settings', 'YourLabel', '4', '21-07-2026', '23-07-2026', '25-07-2026'],
        ['', 'Example management task — replace me', '', 'Management Task', 'A management task type from Settings', 'Developer name from Settings', 'YourLabel', '1.5', '21-07-2026', '21-07-2026', '21-07-2026']
      ]

      const csv = [header, ...rows].map((r) => r.map(quote).join(',')).join('\n')
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-Disposition', 'attachment; filename="subtask-template.csv"')
      res.send(csv)
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.post('/api/developers', async (req, res) => {
    try {
      const { id, name, previousId } = req.body ?? {}
      if (!id?.trim() || !name?.trim()) {
        return res.status(400).json({ errors: ['Both the Jira account id and the name are required'] })
      }
      await db.upsertDeveloper(id.trim(), name.trim(), previousId?.trim() || undefined)
      res.json({ ok: true })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.delete('/api/developers/:id', async (req, res) => {
    try {
      await db.deleteDeveloper(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.post('/api/task-types', async (req, res) => {
    try {
      const { id, value, category, previousId } = req.body ?? {}
      if (!id?.trim() || !value?.trim()) {
        return res.status(400).json({ errors: ['Both the Jira field option id and the label are required'] })
      }
      if (category !== 'developer' && category !== 'management') {
        return res.status(400).json({ errors: ['category must be "developer" or "management"'] })
      }
      await db.upsertTaskType(id.trim(), value.trim(), category, previousId?.trim() || undefined)
      res.json({ ok: true })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.delete('/api/task-types/:id', async (req, res) => {
    try {
      await db.deleteTaskType(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      errorResponse(res, err)
    }
  })

  app.listen(PORT, () => console.log(`UI running at http://localhost:${PORT}`))
}

run().catch((e) => (console.error(e), process.exit(1)))
