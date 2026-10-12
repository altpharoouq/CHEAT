import * as workflow from '@temporalio/workflow';

import type * as activities from './activities';

import type { Row } from './types';

const { createSubtask, planSubtask, transitionSubtask, updateSubtask } = workflow.proxyActivities<typeof activities>({ startToCloseTimeout: '1 minute' })

export type StageName = 'create' | 'plan' | 'transition'
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type RowStatus = {
  summary: string
  developer: string
  status: 'pending' | 'running' | 'done' | 'updated' | 'failed' | 'skipped'
  stages: Record<StageName, StageStatus>
  issueKey?: string
  error?: string
}

export type SheetRunInput = {
  rows: Row[]
  parentKey: string
  sheetUrl: string
  // Rows that already exist as subtasks of the parent in Jira — updated in place instead of created
  existingIssues?: Array<{ summary: string, issueKey: string }>
  // Rows that exist and whose Jira fields already match the sheet — skipped without touching Jira
  unchangedIssues?: Array<{ summary: string, issueKey: string }>
  // Rows that already exist under the parent — listed on the run, never created or updated
  alreadyInJira?: Array<{ summary: string, issueKey: string }>
  // Email of the logged-in user whose Jira token creates/updates these subtasks
  actorEmail?: string
}

export type SheetRunResult = {
  done: number
  updated: number
  failed: number
  skipped: number
}

export const progressQuery = workflow.defineQuery<RowStatus[]>('progress')
export const stageSignal = workflow.defineSignal<[{ rowIndex: number, stage: StageName, status: StageStatus }]>('stageUpdate')

const STAGES: StageName[] = ['create', 'plan', 'transition']

const rootCause = (err: unknown): Error | unknown => {
  let root = err
  while (root instanceof Error && root.cause instanceof Error) {
    root = root.cause
  }
  return root
}

const errorMessage = (err: unknown): string => {
  const root = rootCause(err)
  return root instanceof Error ? root.message : String(root)
}

export const processSubtask = async (payload: Row, rowIndex?: number, existingIssueKey?: string, actorEmail?: string): Promise<string> => {
  const parent = workflow.workflowInfo().parent

  // Report stage transitions up to the parent workflow so the UI can show them live
  const report = async (stage: StageName, status: StageStatus): Promise<void> => {
    if (!parent || rowIndex === undefined) return
    try {
      await workflow.getExternalWorkflowHandle(parent.workflowId, parent.runId).signal(stageSignal, { rowIndex, stage, status })
    } catch {
      // A missing parent must never fail the subtask itself
    }
  }

  // The subtask already exists in Jira: push the sheet's field values onto it instead of creating.
  // Transition is deliberately not re-run — the issue may have moved on in its board lifecycle.
  if (existingIssueKey) {
    await report('create', 'skipped')
    await report('transition', 'skipped')

    try {
      await report('plan', 'running')
      await updateSubtask(existingIssueKey, payload, actorEmail)
      await report('plan', 'done')
      return existingIssueKey
    } catch (err) {
      await report('plan', 'failed')
      throw workflow.ApplicationFailure.create({
        message: `Failed updating ${existingIssueKey}: ${errorMessage(err)}`,
        details: [payload],
        cause: err instanceof Error ? err : undefined
      })
    }
  }

  let issueKey: string | undefined
  let stage: StageName = 'create'

  try {
    await report('create', 'running')
    issueKey = await createSubtask(payload, actorEmail)
    await report('create', 'done')

    stage = 'plan'
    await report('plan', 'running')
    await planSubtask(issueKey, payload, actorEmail)
    await report('plan', 'done')

    stage = 'transition'
    await report('transition', 'running')
    await transitionSubtask(issueKey, payload, actorEmail)
    await report('transition', 'done')

    return issueKey
  } catch (err) {
    await report(stage, 'failed')

    // If the issue was already created, surface its key so it isn't silently orphaned
    const orphanNote = issueKey ? `Issue ${issueKey} was created, but a later step failed. ` : ''

    throw workflow.ApplicationFailure.create({
      message: `${orphanNote}Failed at the "${stage}" stage: ${errorMessage(err)}`,
      details: [payload],
      cause: err instanceof Error ? err : undefined
    })
  }
}

// Deterministic child workflow id: same parent + summary can never create a duplicate subtask
const childWorkflowId = (parentKey: string, summary: string): string => {
  const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
  return `subtask-${parentKey.toLowerCase()}-${slug}`
}

export const processSheet = async (input: SheetRunInput): Promise<SheetRunResult> => {
  const statuses: RowStatus[] = input.rows.map((row) => ({
    summary: row.summary,
    developer: String(row.developer ?? ''),
    status: 'pending',
    stages: { create: 'pending', plan: 'pending', transition: 'pending' }
  }))

  workflow.setHandler(progressQuery, () => statuses)
  workflow.setHandler(stageSignal, ({ rowIndex, stage, status }) => {
    if (statuses[rowIndex]) statuses[rowIndex].stages[stage] = status
  })

  const result: SheetRunResult = { done: 0, updated: 0, failed: 0, skipped: 0 }
  const existing = new Map((input.existingIssues ?? []).map((e) => [e.summary, e.issueKey]))
  const unchanged = new Map((input.unchangedIssues ?? []).map((e) => [e.summary, e.issueKey]))

  const inJira = new Map((input.alreadyInJira ?? []).map((e) => [e.summary, e.issueKey]))

  for (let i = 0; i < input.rows.length; i++) {
    const inJiraKey = inJira.get(input.rows[i].summary)
    if (inJiraKey) {
      statuses[i].status = 'skipped'
      statuses[i].issueKey = inJiraKey
      statuses[i].error = 'Already in Jira'
      for (const stage of STAGES) statuses[i].stages[stage] = 'skipped'
      result.skipped++
      continue
    }

    const unchangedKey = unchanged.get(input.rows[i].summary)
    if (unchangedKey) {
      statuses[i].status = 'skipped'
      statuses[i].issueKey = unchangedKey
      statuses[i].error = 'No changes'
      for (const stage of STAGES) statuses[i].stages[stage] = 'skipped'
      result.skipped++
      continue
    }

    const existingKey = existing.get(input.rows[i].summary)

    if (existingKey) {
      // Already in Jira: sync the sheet's fields onto the existing issue
      statuses[i].status = 'running'
      statuses[i].issueKey = existingKey

      try {
        await workflow.executeChild(processSubtask, {
          args: [input.rows[i], i, existingKey, input.actorEmail],
          workflowId: `${workflow.workflowInfo().workflowId}-update-${i}`
        })
        statuses[i].status = 'updated'
        result.updated++
      } catch (err) {
        statuses[i].status = 'failed'
        statuses[i].error = errorMessage(err)
        result.failed++
      }
      continue
    }

    statuses[i].status = 'running'

    try {
      statuses[i].issueKey = await workflow.executeChild(processSubtask, {
        args: [input.rows[i], i, undefined, input.actorEmail],
        workflowId: childWorkflowId(input.parentKey, input.rows[i].summary),
        workflowIdReusePolicy: 'REJECT_DUPLICATE'
      })
      statuses[i].status = 'done'
      result.done++
    } catch (err) {
      const message = errorMessage(err)

      if (message.toLowerCase().includes('already started') || message.toLowerCase().includes('already exists')) {
        statuses[i].status = 'skipped'
        statuses[i].error = 'Already created in a previous run'
        for (const stage of STAGES) statuses[i].stages[stage] = 'skipped'
        result.skipped++
      } else {
        statuses[i].status = 'failed'
        statuses[i].error = message
        result.failed++
      }
    }
  }

  return result
}
