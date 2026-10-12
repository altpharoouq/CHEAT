export type Columns = 'summary' | 'description' | 'task_type' | 'sub_task_type' | 'developer' | 'label' | 'estimated_hours' | 'start_date' | 'end_date' | 'due_date' | 'parent_key' | 'issue_id'

export type Row = { [K in Columns]: K extends 'estimated_hours' ? number : K extends 'start_date' | 'end_date' | 'due_date' | 'summary' | 'parent_key' ? string : K extends 'issue_id' ? string | undefined : string | undefined | { id: string, value: string } | Array<{ id: string, value: string }> | undefined }

export type Database = Array<Row>
