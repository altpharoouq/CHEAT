// Where Temporal lives. Locally it's docker compose on localhost:7233; on Render the private
// service's internal hostname arrives as TEMPORAL_HOST (TEMPORAL_ADDRESS overrides both).
export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS
  ?? `${process.env.TEMPORAL_HOST ?? 'localhost'}:${process.env.TEMPORAL_PORT ?? '7233'}`

export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default'
