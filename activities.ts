import { ApplicationFailure } from '@temporalio/common'
import axios from 'axios'

import { getSettings, getUserToken } from './db'

import type { AxiosInstance } from 'axios'
import type { Row } from './types'

const DEFAULT_PARENT_ID = '49184' //  Fallback for CLI runs; UI runs carry parent_key in the payload
export const PROJECT_ID = '10198'
const DEVELOPER_ISSUE_TYPE = '10378'
const MANAGEMENT_ISSUE_TYPE = '10542'

// Jira custom field ids, shared with the server for diffing and lookup sync
export const FIELD_DEV_SUBTASK_TYPE = 'customfield_10608'
export const FIELD_MGMT_SUBTASK_TYPE = 'customfield_11066'
export const FIELD_DEVELOPER = 'customfield_10607'
export const FIELD_ESTIMATED_HOURS = 'customfield_10605'
export const FIELD_START_DATE = 'customfield_10571'
export const FIELD_END_DATE = 'customfield_10572'

const PLANNED_TRANSITION_ID = '11'

// One cached client per identity (per-user email, or 'service' for the CLI fallback)
const clientCache = new Map<string, { client: AxiosInstance, at: number }>()

// Always act as the logged-in user who started the run, with their own Jira token
const getClient = async (actorEmail?: string): Promise<AxiosInstance> => {
  if (!actorEmail) {
    throw ApplicationFailure.create({ message: 'This run has no user attached — start it from the UI while signed in', nonRetryable: true })
  }

  const hit = clientCache.get(actorEmail)
  if (hit && Date.now() - hit.at < 30_000) return hit.client

  const settings = await getSettings()
  const token = await getUserToken(actorEmail)
  if (!token) {
    throw ApplicationFailure.create({
      message: `No stored Jira token for ${actorEmail} — that user must log in again`,
      nonRetryable: true
    })
  }
  const username = actorEmail
  const password = token

  const client = axios.create({
    baseURL: `${settings.jiraBaseUrl.replace(/\/+$/, '')}/rest/api/3`,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    auth: { username, password }
  })

  client.interceptors.response.use(undefined, (error) => {
    if (axios.isAxiosError(error) && error.response) {
      const message = `${error.message} — ${error.config?.method?.toUpperCase()} ${error.config?.url}: ${JSON.stringify(error.response.data)}`
      const status = error.response.status

      // A 4xx (except 429 rate limiting) will never succeed on retry — fail the activity immediately
      if (status >= 400 && status < 500 && status !== 429) {
        return Promise.reject(ApplicationFailure.create({ message, nonRetryable: true, cause: error }))
      }

      error.message = message
    }
    return Promise.reject(error)
  })

  clientCache.set(actorEmail, { client, at: Date.now() })
  return client
}

// Plain text -> Atlassian Document Format, one paragraph per non-blank line
// (ADF rejects empty text nodes, so blank lines are dropped)
const toAdf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: line }]
  }))
})

export const createSubtask = async (payload: Row, actorEmail?: string): Promise<string> => {
  const issueTypeId = payload.task_type === 'Developer Task'
    ? DEVELOPER_ISSUE_TYPE
    : payload.task_type === 'Management Task'
    ? MANAGEMENT_ISSUE_TYPE
    : undefined

  const subtaskField = payload.task_type === 'Developer Task'
    ? 'customfield_10608'
    : payload.task_type === 'Management Task'
    ? 'customfield_11066'
    : undefined

  // Parent may be an issue key like "AET-123" (from the UI) or a numeric internal id
  const parent = payload.parent_key || DEFAULT_PARENT_ID
  const parentRef = /^[A-Z][A-Z0-9]*-\d+$/.test(parent) ? { key: parent } : { id: parent }

  const client = await getClient(actorEmail)
  const response = await client.post('/issue', JSON.stringify({
    fields: {
      parent: parentRef,
      project: {
        id: PROJECT_ID
      },
      issuetype: {
        id: issueTypeId
      },
      summary: payload.summary,
      description: toAdf(String(payload.description || payload.summary)),
      ...(subtaskField ? {
        [subtaskField]: payload.task_type === 'Developer Task' ? [payload.sub_task_type] : payload.sub_task_type
      } : {}),
      ...(payload.task_type === 'Developer Task' ? { 
        customfield_10607: {
          id: payload.developer
        },
        labels: [payload.label]
      } : payload.task_type === 'Management Task' ? {
        assignee: {
          id: payload.developer
        }
      } : {})
    }
  }))

  return response.data.key
}

// Push the sheet-owned fields onto an already-existing subtask (used when re-syncing a sheet)
export const updateSubtask = async (issueKey: string, payload: Row, actorEmail?: string): Promise<void> => {
  const subtaskField = payload.task_type === 'Developer Task'
    ? 'customfield_10608'
    : payload.task_type === 'Management Task'
    ? 'customfield_11066'
    : undefined

  const client = await getClient(actorEmail)
  await client.put(`/issue/${issueKey}`, JSON.stringify({
    fields: {
      summary: payload.summary,
      description: toAdf(String(payload.description || payload.summary)),
      ...(subtaskField ? {
        [subtaskField]: payload.task_type === 'Developer Task' ? [payload.sub_task_type] : payload.sub_task_type
      } : {}),
      ...(payload.task_type === 'Developer Task' ? {
        customfield_10607: {
          id: payload.developer
        },
        labels: [payload.label],
        customfield_10605: +payload.estimated_hours,
        customfield_10571: payload.start_date,
        customfield_10572: payload.end_date,
        duedate: payload.due_date
      } : payload.task_type === 'Management Task' ? {
        assignee: {
          id: payload.developer
        },
        customfield_10605: +payload.estimated_hours,
        duedate: payload.due_date
      } : {})
    }
  }))
}

export const planSubtask = async (issueKey: string, payload: Row, actorEmail?: string): Promise<void> => {
  const client = await getClient(actorEmail)

  if (payload.task_type === 'Developer Task') {
    await client.put(`/issue/${issueKey}`, JSON.stringify({
      fields: {
        customfield_10605: +payload.estimated_hours,
        customfield_10571: payload.start_date,
        customfield_10572: payload.end_date,
        duedate: payload.due_date
      }
    }))
  } else if (payload.task_type === 'Management Task') {
    await client.put(`/issue/${issueKey}`, JSON.stringify({
      fields: {
        customfield_10605: +payload.estimated_hours,
        duedate: payload.due_date
      }
    }))
  }
  
  return
}

export const transitionSubtask = async (issueKey: string, payload: Row, actorEmail?: string): Promise<void> => {
  const client = await getClient(actorEmail)

  if (payload.task_type === 'Developer Task') {
    await client.post(`/issue/${issueKey}/transitions`, JSON.stringify({
      transition: {
        id: PLANNED_TRANSITION_ID
      }
    }))
  }

  return
}