import type { Row } from './types'

export type Lookups = {
  developers: Array<{ id: string, name: string }>
  developerTaskTypes: Array<{ id: string, value: string }>
  managementTaskTypes: Array<{ id: string, value: string }>
}

export const SEED_DEVELOPERS = [
  { 'id': '712020:3a36eaf8-0d90-4c23-9788-84c470aaa4ee', 'name': 'Olutunde Solabi' },
  { 'id': '712020:e15f75a4-1479-43ce-92dc-03c5e1918d8c', 'name': 'Kevin Omini' },
  { 'id': '712020:6455960e-5f50-403e-877c-817576631833', 'name': 'Gbenga Omowole' },
  { 'id': '62fb3b181e82e839c24f97cb', 'name': 'Daniel Didah' },
  { 'id': '616443ad7a6be400715185e6', 'name': 'Joshua Owolabi' },
  { 'id': '62fa2fcbd75f523a60ed81e7', 'name': 'Faruq Alli-Balogun' },
  { 'id': '6278e1b293111000689f5bb2', 'name': 'Adewale Akano' },
]

export const SEED_DEVELOPER_TASK_TYPES = [
  { 'id': '11214', 'value': '3rd Party Task' },
  { 'id': '10488', 'value': 'Backend Development Task' },
  { 'id': '10499', 'value': 'Feature Flag/Toggle Task' },
  { 'id': '10489', 'value': 'Frontend Development Task' },
  { 'id': '10495', 'value': 'Integration Task' },
  { 'id': '10490', 'value': 'Mobile App Development Task' },
  { 'id': '10496', 'value': 'Performance Optimization Task' },
  { 'id': '10492', 'value': 'DevOps/Infrastructure Task' },
  { 'id': '10884', 'value': 'UI/UX Improvement' },
]

export const SEED_MANAGEMENT_TASK_TYPES = [
  { 'id': '11216', 'value': 'Scoping' },
  { 'id': '11218', 'value': 'Planning' },
  { 'id': '11217', 'value': 'Design' },
  { 'id': '11215', 'value': 'Meeting & Communication' },
  { 'id': '11219', 'value': 'Training' },
]

export const SEED_LOOKUPS: Lookups = {
  developers: SEED_DEVELOPERS,
  developerTaskTypes: SEED_DEVELOPER_TASK_TYPES,
  managementTaskTypes: SEED_MANAGEMENT_TASK_TYPES
}

// Jira expects YYYY-MM-DD; the sheets use DD-MM-YYYY, which new Date() can't parse
const parseDate = (value: string | undefined, field: string, rowLabel: string, errors: string[]): string => {
  if (!value) return new Date().toISOString().split('T')[0]

  const match = value.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (!match) {
    errors.push(`${rowLabel}: invalid ${field} "${value}" — expected DD-MM-YYYY`)
    return ''
  }

  const [, day, month, year] = match
  const date = new Date(Date.UTC(+year, +month - 1, +day))
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day) {
    errors.push(`${rowLabel}: invalid ${field} "${value}" — not a real calendar date`)
    return ''
  }

  return `${year}-${month}-${day}`
}

// Validates + resolves raw breakdown records into Jira-ready rows
export const buildRowsFromRecords = (records: any[], parentKey: string, lookups: Lookups): { rows: Row[], errors: string[] } => {
  const rows: Row[] = []
  const errors: string[] = []

  if (records.length === 0) {
    errors.push('There are no data rows')
  }

  records.forEach((x, index) => {
    // Trailing periods look off in Jira issue titles
    const summary = String(x.summary ?? '').trim().replace(/\.+$/, '')
    const rowLabel = `Row ${index + 2} ("${summary.slice(0, 60) || 'no summary'}")`

    if (!summary) {
      errors.push(`${rowLabel}: summary is empty`)
    }

    if (x.task_type !== 'Developer Task' && x.task_type !== 'Management Task') {
      errors.push(`${rowLabel}: unknown task_type "${x.task_type}" — expected "Developer Task" or "Management Task"`)
    }

    const developer = lookups.developers.find((y) => y.name === x.developer)?.id
    if (!developer) {
      errors.push(`${rowLabel}: unknown developer "${x.developer}" — expected one of: ${lookups.developers.map((y) => y.name).join(', ')}`)
    }

    const sub_task_type = x.task_type === 'Developer Task'
      ? lookups.developerTaskTypes.find((y) => y.value === x.sub_task_type)
      : x.task_type === 'Management Task'
      ? lookups.managementTaskTypes.find((y) => y.value === x.sub_task_type)
      : undefined
    if (!sub_task_type) {
      const table = x.task_type === 'Management Task' ? lookups.managementTaskTypes : lookups.developerTaskTypes
      errors.push(`${rowLabel}: unknown sub_task_type "${x.sub_task_type}" — expected one of: ${table.map((y) => y.value).join(', ')}`)
    }

    if (Number.isNaN(+x.estimated_hours)) {
      errors.push(`${rowLabel}: estimated_hours "${x.estimated_hours}" is not a number`)
    }

    rows.push({
      label: x.label,
      summary,
      description: String(x.description ?? '').trim() || summary,
      task_type: x.task_type,
      estimated_hours: x.estimated_hours,
      developer: developer ?? '',
      sub_task_type,
      start_date: parseDate(x.start_date, 'start_date', rowLabel, errors),
      end_date: parseDate(x.end_date, 'end_date', rowLabel, errors),
      due_date: parseDate(x.due_date, 'due_date', rowLabel, errors),
      parent_key: parentKey,
      // Optional "id" column with the Jira issue key makes renames safe (matched by id, not summary)
      issue_id: String(x.id ?? '').trim().toUpperCase() || undefined
    })
  })

  return { rows, errors }
}

// RFC 4180-ish CSV -> objects keyed by the (trimmed) header row. Handles quoted fields
// containing commas, escaped quotes ("") and line breaks, CRLF endings and a leading BOM.
const parseCsvObjects = (csvText: string): Array<Record<string, string>> => {
  const text = csvText.replace(/^\uFEFF/, '')
  const table: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); table.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) { row.push(field); table.push(row) }

  const [header = [], ...body] = table
  const keys = header.map((h) => h.trim())
  return body
    .filter((cells) => cells.some((v) => v.trim() !== ''))
    .map((cells) => Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? ''])))
}

const CSV_COLUMNS = ['id', 'summary', 'description', 'task_type', 'sub_task_type', 'developer', 'label', 'estimated_hours', 'start_date', 'end_date', 'due_date'] as const

// Raw CSV -> plain string records with just the template columns. Headers are matched
// case-insensitively; fully blank rows are dropped.
export const parseCsvRecords = (csvText: string): Array<Record<typeof CSV_COLUMNS[number], string>> =>
  parseCsvObjects(csvText)
    .map((r) => {
      const byHeader = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v.trim()]))
      return Object.fromEntries(CSV_COLUMNS.map((c) => [c, byHeader[c] ?? ''])) as Record<typeof CSV_COLUMNS[number], string>
    })
    .filter((r) => Object.values(r).some(Boolean))
