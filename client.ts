import { Client, Connection } from '@temporalio/client'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'

import { buildRowsFromRecords, parseCsvRecords, SEED_LOOKUPS } from './rows'
import { TEMPORAL_NAMESPACE, temporalConnectionOptions } from './temporal'
import { processSubtask } from './workflows'

const TEMPORAL_TASK_QUEUE_NAME = 'subtask-processing'

const run = async () => {
  // Jira credentials are per user: act as someone who has signed in to the UI at least once
  const actorEmail = process.env.CHEAT_ACTOR_EMAIL
  if (!actorEmail) {
    console.error('Set CHEAT_ACTOR_EMAIL to the email of a user who has signed in to the UI')
    process.exit(1)
  }

  const rawCSVFileContent = fs.readFileSync('data.csv', { encoding: 'utf-8' })

  // Empty parent_key makes activities fall back to DEFAULT_PARENT_ID
  const { rows, errors } = buildRowsFromRecords(parseCsvRecords(rawCSVFileContent), '', SEED_LOOKUPS)

  if (errors.length > 0) {
    console.error('CSV validation failed — nothing was sent to Jira:')
    errors.forEach((e) => console.error(`  - ${e}`))
    process.exit(1)
  }

  const client = new Client({
    connection: await Connection.connect(temporalConnectionOptions),
    namespace: TEMPORAL_NAMESPACE
  })

  await Promise.all(rows.map((row) =>
    client.workflow.start(processSubtask, {
      args: [row, undefined, undefined, actorEmail],
      workflowId: crypto.randomUUID(),
      staticDetails: row.summary,
      taskQueue: TEMPORAL_TASK_QUEUE_NAME
    })
  ))

  console.log(`Started ${rows.length} workflows`)
}

run().catch((e) => (console.error(e), process.exit(1)))
