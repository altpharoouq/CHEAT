// Where Temporal lives. Locally: docker compose on localhost:7233, no auth.
// Temporal Cloud: TEMPORAL_ADDRESS is the namespace (or regional) endpoint, e.g.
// my-ns.a1b2c.tmprl.cloud:7233, TEMPORAL_NAMESPACE is "my-ns.a1b2c", and TEMPORAL_API_KEY
// switches on TLS + API-key auth.
export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS
  ?? `${process.env.TEMPORAL_HOST ?? 'localhost'}:${process.env.TEMPORAL_PORT ?? '7233'}`

export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default'

const TEMPORAL_API_KEY = process.env.TEMPORAL_API_KEY

// Shared by Connection (client) and NativeConnection (worker)
export const temporalConnectionOptions = {
  address: TEMPORAL_ADDRESS,
  ...(TEMPORAL_API_KEY ? { tls: true, apiKey: TEMPORAL_API_KEY } : {})
}
