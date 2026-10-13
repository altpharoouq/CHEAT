// Web server + worker in one process — for hosts without a free background-worker tier
// (e.g. a single free Render web service). Locally, run them separately as before.
import './server'
import './worker'
