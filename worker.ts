import { NativeConnection, Worker } from '@temporalio/worker'

import * as activities from './activities'
import { TEMPORAL_NAMESPACE, temporalConnectionOptions } from './temporal'

const TEMPORAL_TASK_QUEUE_NAME = 'subtask-processing'

const run = async () => {
  const connection = await NativeConnection.connect(temporalConnectionOptions)

  await(await Worker.create({
    activities, connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TEMPORAL_TASK_QUEUE_NAME,
    workflowsPath: require.resolve('./workflows'),
    maxActivitiesPerSecond: 1
  })).run()
}

run().catch((e) => (console.error(e), process.exit(1)))