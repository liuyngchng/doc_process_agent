import Database from 'better-sqlite3';
import { join } from 'node:path';
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { nowReadable, nowTs, fmtLocalTs } from './time.js';
import type { AgentInterface, TaskLog, TaskStatus, User, Session } from './types.js';

let db: Database.Database;

export function initStore(dataDir: string): Database.Database {
  db = new Database(join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_interfaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL UNIQUE,
      prompt      TEXT NOT NULL,
      created_at  TEXT,
      updated_at  TEXT,
      created_ts  INTEGER,
      updated_ts  INTEGER
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      task_id       TEXT PRIMARY KEY,
      linkid        TEXT,
      session_id    TEXT,
      path          TEXT,
      interface_id  TEXT,
      status        TEXT,
      request_body  TEXT,
      request_response TEXT,
      prompt        TEXT,
      sdk_output    TEXT,
      callback_body TEXT,
      callback_response TEXT,
      callback_url  TEXT,
      error_message TEXT,
      created_at    TEXT,
      finished_at   TEXT,
      created_ts    INTEGER,
      finished_ts   INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id  TEXT PRIMARY KEY,
      linkid      TEXT NOT NULL UNIQUE,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT,
      updated_at  TEXT,
      created_ts  INTEGER,
      updated_ts  INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      role            INTEGER DEFAULT 0,
      note            TEXT DEFAULT '',
      must_change_pwd INTEGER DEFAULT 0,
      created_at      TEXT,
      created_ts      INTEGER
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      note  TEXT
    );
  `);
  // Migration: add session_id column
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN session_id TEXT`); } catch { /* already exists */ }
  // Migration: add sdk_trace column if missing (added in v0.1.x) — kept for backward compat, no longer written
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN sdk_trace TEXT`); } catch { /* already exists */ }
  // Migration: add sdk_stream column for real-time agent output (added in v0.2.x) — kept for backward compat, no longer written
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN sdk_stream TEXT`); } catch { /* already exists */ }
  // Migration: add request_response / callback_response columns (added in v0.3.x)
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN request_response TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN callback_response TEXT`); } catch { /* already exists */ }
  // Migration: add users / config tables if missing (added in v0.2.x)
  try { db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role INTEGER DEFAULT 0, note TEXT DEFAULT '', must_change_pwd INTEGER DEFAULT 0, created_at TEXT)`); } catch { /* already exists */ }
  try { db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, note TEXT)`); } catch { /* already exists */ }
  // Migration: add must_change_pwd column
  try { db.exec(`ALTER TABLE users ADD COLUMN must_change_pwd INTEGER DEFAULT 0`); } catch { /* already exists */ }
  // Migration: add user_version column for per-user token invalidation
  try { db.exec(`ALTER TABLE users ADD COLUMN user_version INTEGER DEFAULT 1`); } catch { /* already exists */ }
  // Migration: add *_ts Unix 毫秒时间戳列（检索用）
  try { db.exec(`ALTER TABLE agent_interfaces ADD COLUMN created_ts INTEGER`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_interfaces ADD COLUMN updated_ts INTEGER`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN created_ts INTEGER`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN finished_ts INTEGER`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN created_ts INTEGER`); } catch { /* already exists */ }
  // Migration: sessions table metadata columns
  try { db.exec(`ALTER TABLE sessions ADD COLUMN created_at TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN updated_at TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN created_ts INTEGER`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE sessions ADD COLUMN updated_ts INTEGER`); } catch { /* already exists */ }

  backfillTsColumns(db);

  seedDefaults(db);
  return db;
}

/**
 * 回填 *_ts 列：旧数据 *_at 是 ISO 字符串，转成 Unix 毫秒；
 * 同时把 *_at 从 ISO 转成可读本地时间（YYYY-MM-DD HH:MM:ss.SSS）。
 */
function backfillTsColumns(db: Database.Database): void {
  const rows = [
    { table: 'agent_interfaces', ts: 'created_ts', at: 'created_at' },
    { table: 'agent_interfaces', ts: 'updated_ts', at: 'updated_at' },
    { table: 'task_logs', ts: 'created_ts', at: 'created_at' },
    { table: 'task_logs', ts: 'finished_ts', at: 'finished_at' },
    { table: 'users', ts: 'created_ts', at: 'created_at' },
  ];

  for (const { table, ts, at } of rows) {
    const stale = db.prepare(
      `SELECT rowid, ${at} AS at_val FROM ${table} WHERE ${ts} IS NULL AND ${at} IS NOT NULL`
    ).all() as Array<{ rowid: number; at_val: string }>;

    const update = db.prepare(`UPDATE ${table} SET ${ts} = ?, ${at} = ? WHERE rowid = ?`);
    for (const r of stale) {
      const ms = Date.parse(r.at_val);
      if (Number.isNaN(ms)) continue;
      update.run(ms, fmtLocalTs(ms), r.rowid);
    }
  }
}

export function getDb(): Database.Database {
  return db;
}

// 初始化默认访问路径
function seedDefaults(db: Database.Database) {
  const ifaceCount = (db.prepare('SELECT COUNT(*) AS c FROM agent_interfaces').get() as { c: number }).c;
  if (ifaceCount === 0) {
    const now = nowReadable();
    const ts = nowTs();
    const insert = db.prepare(
      'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );

    insert.run(uuid(), '收文分类', 'doc/classify', defaultClassifyPrompt(), now, now, ts, ts);
    insert.run(uuid(), '流转目标识别', 'doc/route', defaultRoutePrompt(), now, now, ts, ts);
    insert.run(uuid(), '发文审核', 'doc/review', defaultDispatchReviewPrompt(), now, now, ts, ts);
  }

  // 初始化默认 admin 用户（密码 admin/admin，首次登录必须改密）
  const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (userCount === 0) {
    db.prepare(
      'INSERT INTO users (username, password_hash, role, note, must_change_pwd, created_at, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('admin', hashPasswordSync('admin'), 1, '默认管理员', 1, nowReadable(), nowTs());
  }
}

function defaultClassifyPrompt(): string {
  return `# 文档处理任务

你需要处理一份电子公文。以下是请求信息：

\`\`\`json
{{request.body}}
\`\`\`

## 执行步骤

### 步骤 1：下载文件
遍历请求中的 \`files\` 数组，用 curl 下载每个 \`file_url\` 到工作目录。文件 URL 无需认证即可直接下载。

### 步骤 2：读取文件内容
用 Read 工具读取下载的文件。

### 步骤 3：分析并输出
根据文件内容和表单数据进行分析。

## 输出要求

请按以下 JSON Schema 输出最终结果，用 \`\`\`json 代码块包裹：

\`\`\`json
{
  "need_human": false,
  "fail_reason": "",
  "doc_type": "company",
  "source_type": "group",
  "form_fill": {
    "file_no": "",
    "from_org": "",
    "deadline": "",
    "doc_date": ""
  },
  "opinion_text": "",
  "need_manual_restart": false,
  "ledger_data": null
}
\`\`\`

## 注意事项
- 所有文本字段（fail_reason、opinion_text、desc 等）必须输出简体中文
- 文件下载前先检查本地是否已有该文件
- 如果文件无法下载，将 need_human 设为 true 并在 fail_reason 中说明原因
- 不要输出任何其他内容，只输出 JSON`;
}

function defaultRoutePrompt(): string {
  return `# 流转目标识别任务

你需要根据审批意见识别下一流转节点。以下是请求信息：

\`\`\`json
{{request.body}}
\`\`\`

## 执行步骤

### 步骤 1：下载并读取文件
遍历请求中的 \`files\` 数组，用 curl 下载文件并用 Read 工具读取。

### 步骤 2：分析
结合 \`approval_history\`（审批意见）、\`next_nodes\`（可选节点）、\`leader_division\`（领导分工）等信息，判断应该选中的下一节点。

## 输出要求

请按以下 JSON Schema 输出最终结果，用 \`\`\`json 代码块包裹：

\`\`\`json
{
  "need_human": false,
  "fail_reason": "",
  "next_node": {
    "id": "",
    "name": "",
    "type": "person"
  },
  "opinion_text": "",
  "form_fill": {},
  "remark": ""
}
\`\`\`

## 注意事项
- 所有文本字段（fail_reason、opinion_text、remark 等）必须输出简体中文
- next_node 必须从 next_nodes / person_list / org_list 中选择已存在的节点
- 如果无法确定，将 need_human 设为 true 并在 fail_reason 中说明原因
- 不要输出任何其他内容，只输出 JSON`;
}

function defaultDispatchReviewPrompt(): string {
  return `# 发文审核任务

你需要对一篇发文进行全面的审核把关。以下是请求信息：

\`\`\`json
{{request.body}}
\`\`\`

## 请求结构说明

- \`form_data\`: 表单元数据（标题、文种、紧急程度、密级、主送机关等）
- \`files\`: 文件数组，其中 \`file_type\` = \`"main_body"\` 的是正文（.docx），其余为附件
- \`approval_history\`: 审批流转记录（含各部门会签意见）
- \`workflowDefine_name\`: 工作流名称
- \`current_step\`: 当前步骤

## 执行步骤

### 步骤 1：下载所有文件
- 遍历 \`files\` 数组，用 curl 下载每个 \`file_url\` 到工作目录
- 记录每个文件的原始文件名和类型（正文 / 附件）

### 步骤 2：提取正文文本
- 对正文（\`file_type\` = \`"main_body"\`）调用文档解析服务，获取纯文本
- 对附件也调用文档解析服务，用于步骤 5 中核对附件名称

### 步骤 3：提交 rdCLI 自动核稿（体例格式）
- 将正文 .docx 文件提交到 rdCLI 审稿服务（见 CLAUDE.md 中的调用说明）
- \`additional_instructions\` 设为 \`"请严格按 GB/T 9704-2012 党政机关公文格式标准进行全面校对，重点关注：发文字号、标题层级、主送机关、正文结构、附件说明格式、落款（成文日期、印章）、专用语规范。仅输出有问题的项目，如果某类别无问题则无需列出。"\`
- 通过轮询 \`GET /api/proofread/task?id=<taskId>\` 获取结果
- 每次轮询间隔 15 秒，最多等待 5 分钟
- 将 \`data.result_text\`（Markdown 核稿意见）保存下来，后续步骤会用到

### 步骤 4：Agent 独立审核（政策与合规 + 内容与逻辑）

结合正文文本和表单元数据，审核以下维度：

**（一）政策与合规审核**
- 发文是否必要：根据标题和正文内容判断，无实质内容则标记
- 文种选用是否正确：对照《党政机关公文处理工作条例》，检查文种（通知/报告/请示/函/纪要等）是否匹配正文内容和发文目的
- 引用文件是否有效：正文中引用的法律法规、上级文件等名称是否完整、文号是否正确
- 发文主体与落款是否一致

**（二）内容与逻辑审核**
- 是否"一文一事"：报告中不得夹带请示事项，请示中不得夹带报告事项
- 逻辑是否通顺：表述清楚、层次清晰、无歧义、无矛盾
- 关键要素是否完整：时间、地点、事由、办理要求等

**（三）程序与附件审核**
- 附件箱中文件名称是否与正文中"附件1""附件2"的顺序和名称一致
- 检查 \`approval_history\` 中是否完成了必要的部门会签（如果正文提到需要会签，但历史上没有对应的会签节点，则标记）
- 检查审批流程是否完整

### 步骤 5：汇总生成审核报告

将步骤 3（rdCLI 体例格式校对）和步骤 4（Agent 政策/内容/程序审核）的结果汇总为一份完整的 Markdown 审核报告。

## 输出要求

请按以下 JSON Schema 输出最终结果，用 \`\`\`json 代码块包裹：

\`\`\`json
{
  "audit_result": "warning",
  "result_text": "## 发文审核报告\\n\\n**审核时间**: 2026-01-15\\n**标题**: xx公司关于xx的通知\\n\\n---\\n\\n### 一、政策与合规审核\\n\\n#### 1.1 发文必要性\\n该文涉及...确有必要发文。\\n\\n#### 1.2 文种选用\\n使用\\"通知\\"文种，符合...\\n\\n...\\n\\n### 二、内容与逻辑审核\\n\\n...\\n\\n### 三、体例格式审核\\n\\n（以下为 rdCLI 自动核稿意见）\\n\\n#### 3.1 错别字\\n...\\n\\n### 四、程序与附件审核\\n\\n...\\n\\n### 五、审核结论\\n\\n> 共发现 xx 个问题（严重 yy 项、一般 zz 项、提示 ww 项）。建议...",
  "issues_count": 5,
  "need_human": false
}
\`\`\`

## 字段说明

| 字段 | 说明 |
|------|------|
| \`audit_result\` | \`"pass"\` 审核通过，可直接进入下一流程；\`"warning"\` 有问题但不卡流程，供拟稿人参考修改 |
| \`result_text\` | **完整的 Markdown 格式审核报告**，包含所有四个审核维度的详细意见，供前端直接渲染展示。rdCLI 的核稿意见整合到"体例格式审核"部分，原文/修改建议/修改理由逐条列出 |
| \`issues_count\` | 审核发现的问题总数（四项维度合计） |
| \`need_human\` | **永远设为 \`false\`**。审核结果无论通过或警告，都不需要人工介入，直接进入后续流程 |

## 注意事项
- 所有文本内容（\`result_text\`）必须使用简体中文
- \`result_text\` 中的 Markdown 要规范，使用 ## 作为一级标题、### 作为二级标题、**加粗**用于强调
- rdCLI 核稿意见原样保留到 \`result_text\` 的"体例格式审核"章节中，不要改写
- 如果某维度未发现问题，在报告中写"未发现问题"即可，不要留空
- 不要输出任何其他内容，只输出 JSON`;
}

// ============================================================
// 访问路径 CRUD
// ============================================================
export const interfacesStore = {
  list(): AgentInterface[] {
    return db.prepare('SELECT * FROM agent_interfaces ORDER BY created_at DESC').all() as AgentInterface[];
  },
  get(id: string): AgentInterface | undefined {
    return db.prepare('SELECT * FROM agent_interfaces WHERE id = ?').get(id) as AgentInterface | undefined;
  },
  getByPath(path: string): AgentInterface | undefined {
    return db.prepare('SELECT * FROM agent_interfaces WHERE path = ?').get(path) as AgentInterface | undefined;
  },
  create(name: string, path: string, prompt: string): AgentInterface {
    const id = uuid();
    const now = nowReadable();
    const ts = nowTs();
    db.prepare(
      'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, path, prompt, now, now, ts, ts);
    return this.get(id)!;
  },
  update(id: string, name: string, path: string, prompt: string): AgentInterface | undefined {
    const now = nowReadable();
    const ts = nowTs();
    db.prepare(
      'UPDATE agent_interfaces SET name = ?, path = ?, prompt = ?, updated_at = ?, updated_ts = ? WHERE id = ?'
    ).run(name, path, prompt, now, ts, id);
    return this.get(id);
  },
  remove(id: string): boolean {
    return db.prepare('DELETE FROM agent_interfaces WHERE id = ?').run(id).changes > 0;
  },
};

// ============================================================
// 任务日志 CRUD
// ============================================================
export const taskLogsStore = {
  create(log: TaskLog): void {
    db.prepare(
      `INSERT INTO task_logs
       (task_id, linkid, session_id, path, interface_id, status, request_body, request_response, prompt, sdk_output, callback_body, callback_response, callback_url, error_message, created_at, finished_at, created_ts, finished_ts)
       VALUES (@task_id, @linkid, @session_id, @path, @interface_id, @status, @request_body, @request_response, @prompt, @sdk_output, @callback_body, @callback_response, @callback_url, @error_message, @created_at, @finished_at, @created_ts, @finished_ts)`
    ).run(log);
  },
  updateStatus(taskId: string, status: TaskStatus): void {
    db.prepare('UPDATE task_logs SET status = ? WHERE task_id = ?').run(status, taskId);
  },
  updateResult(taskId: string, fields: Partial<TaskLog>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.finished_at !== undefined && fields.finished_ts === undefined) {
      fields = { ...fields, finished_ts: nowTs() };
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(taskId);
    db.prepare(`UPDATE task_logs SET ${sets.join(', ')} WHERE task_id = ?`).run(...vals);
  },
  get(taskId: string): TaskLog | undefined {
    return db.prepare('SELECT * FROM task_logs WHERE task_id = ?').get(taskId) as TaskLog | undefined;
  },
  /** 按 linkid 取最新一条任务 */
  getLatestByLinkid(linkid: string): TaskLog | undefined {
    return db.prepare(
      'SELECT * FROM task_logs WHERE linkid = ? ORDER BY created_at DESC LIMIT 1'
    ).get(linkid) as TaskLog | undefined;
  },
  list(limit = 100): TaskLog[] {
    return db.prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?').all(limit) as TaskLog[];
  },
  /** 分页列出任务日志（created_at DESC），返回当前页与总数 */
  listPaged(offset: number, limit: number): { items: TaskLog[]; total: number } {
    const total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs').get() as { c: number }).c;
    const items = db.prepare(
      'SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as TaskLog[];
    return { items, total };
  },
  countActive(): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM task_logs WHERE status IN ('pending', 'processing')`
    ).get() as { c: number };
    return row.c;
  },
  listActive(): TaskLog[] {
    return db.prepare(
      `SELECT * FROM task_logs WHERE status IN ('pending', 'processing') ORDER BY created_at ASC`
    ).all() as TaskLog[];
  },
  /** 检查指定 linkid 是否有 pending/processing 的任务 */
  hasActiveByLinkid(linkid: string): boolean {
    const row = db.prepare(
      `SELECT 1 AS c FROM task_logs WHERE linkid = ? AND status IN ('pending', 'processing') LIMIT 1`
    ).get(linkid);
    return !!row;
  },
  /**
   * 清理过期的非活跃任务记录（status 不在 pending/processing）。
   * 返回清理的任务数。
   */
  deleteExpired(retentionDays: number): number {
    const cutoffMs = nowTs() - retentionDays * 24 * 3600 * 1000;
    const result = db.prepare(
      `DELETE FROM task_logs
       WHERE created_ts < ?
         AND status NOT IN ('pending', 'processing')`
    ).run(cutoffMs);
    return result.changes;
  },
  /** 返回所有任务的 task_id 列表，用于清理对应的工作目录 */
  listTaskIds(): string[] {
    return (db.prepare('SELECT task_id FROM task_logs').all() as Array<{ task_id: string }>)
      .map((r) => r.task_id);
  },
  /** 按 task_id 或 linkid 查询任务（模糊匹配） */
  search(taskId: string, linkid: string, limit = 100): TaskLog[] {
    if (taskId && linkid) {
      return db.prepare(
        'SELECT * FROM task_logs WHERE task_id LIKE ? AND linkid LIKE ? ORDER BY created_at DESC LIMIT ?'
      ).all(`%${taskId}%`, `%${linkid}%`, limit) as TaskLog[];
    }
    if (taskId) {
      return db.prepare(
        'SELECT * FROM task_logs WHERE task_id LIKE ? ORDER BY created_at DESC LIMIT ?'
      ).all(`%${taskId}%`, limit) as TaskLog[];
    }
    if (linkid) {
      return db.prepare(
        'SELECT * FROM task_logs WHERE linkid LIKE ? ORDER BY created_at DESC LIMIT ?'
      ).all(`%${linkid}%`, limit) as TaskLog[];
    }
    return db.prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?').all(limit) as TaskLog[];
  },
  /** 分页搜索（模糊匹配），返回当前页与总数 */
  searchPaged(taskId: string, linkid: string, offset: number, limit: number): { items: TaskLog[]; total: number } {
    const like = (s: string) => `%${s}%`;
    const items: TaskLog[] = [];
    let total = 0;
    if (taskId && linkid) {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs WHERE task_id LIKE ? AND linkid LIKE ?').get(like(taskId), like(linkid)) as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs WHERE task_id LIKE ? AND linkid LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(like(taskId), like(linkid), limit, offset) as TaskLog[]);
    } else if (taskId) {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs WHERE task_id LIKE ?').get(like(taskId)) as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs WHERE task_id LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(like(taskId), limit, offset) as TaskLog[]);
    } else if (linkid) {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs WHERE linkid LIKE ?').get(like(linkid)) as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs WHERE linkid LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(like(linkid), limit, offset) as TaskLog[]);
    } else {
      total = (db.prepare('SELECT COUNT(*) AS c FROM task_logs').get() as { c: number }).c;
      items.push(...db.prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as TaskLog[]);
    }
    return { items, total };
  },
};

// ============================================================
// Session CRUD（linkid ↔ session_id 映射）
// ============================================================
export const sessionsStore = {
  /** 插入或更新（存在则刷新 updated_at，不存在则新建） */
  upsert(sessionId: string, linkid: string): Session {
    const now = nowReadable();
    const ts = nowTs();
    const existing = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    if (existing) {
      db.prepare('UPDATE sessions SET updated_at = ?, updated_ts = ? WHERE session_id = ?').run(now, ts, sessionId);
    } else {
      db.prepare(
        'INSERT INTO sessions (session_id, linkid, status, created_at, updated_at, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, linkid, 'active', now, now, ts, ts);
    }
    return this.get(sessionId)!;
  },

  get(sessionId: string): Session | undefined {
    return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Session | undefined;
  },

  /** 按 linkid 查找 active session */
  getByLinkid(linkid: string): Session | undefined {
    return db.prepare(
      'SELECT * FROM sessions WHERE linkid = ? AND status = ?'
    ).get(linkid, 'active') as Session | undefined;
  },

  /** 删除 session（同时删除 SDK 侧持久化的对话历史，需要调用方传 deleteSession） */
  remove(sessionId: string): boolean {
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /** 清理过期的 session（updated_ts 超过 retentionDays 天） */
  deleteExpired(retentionDays: number): Session[] {
    const cutoffMs = nowTs() - retentionDays * 24 * 3600 * 1000;
    const expired = db.prepare(
      'SELECT * FROM sessions WHERE updated_ts < ?'
    ).all(cutoffMs) as Session[];
    db.prepare('DELETE FROM sessions WHERE updated_ts < ?').run(cutoffMs);
    return expired;
  },
};

// ============================================================
// 密码工具（bcrypt）
// ============================================================
export function hashPasswordSync(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function comparePasswordSync(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

// ============================================================
// 用户 CRUD
// ============================================================
export const usersStore = {
  get(username: string): User | undefined {
    return db.prepare(
      'SELECT id, username, password_hash, role, note, COALESCE(must_change_pwd,0) AS must_change_pwd, COALESCE(user_version,1) AS user_version, COALESCE(created_at,\'\') AS created_at, created_ts FROM users WHERE username = ?'
    ).get(username) as User | undefined;
  },
  list(): User[] {
    return db.prepare(
      'SELECT id, username, password_hash, role, note, COALESCE(must_change_pwd,0) AS must_change_pwd, COALESCE(user_version,1) AS user_version, COALESCE(created_at,\'\') AS created_at, created_ts FROM users ORDER BY id'
    ).all() as User[];
  },
  updatePassword(username: string, hash: string): boolean {
    return db.prepare('UPDATE users SET password_hash = ?, user_version = user_version + 1 WHERE username = ?').run(hash, username).changes > 0;
  },
  clearMustChangePwd(username: string): boolean {
    return db.prepare('UPDATE users SET must_change_pwd = 0 WHERE username = ?').run(username).changes > 0;
  },
  /** 递增 user_version 以作废该用户所有旧 token（登出时使用） */
  incrementUserVersion(username: string): void {
    db.prepare('UPDATE users SET user_version = user_version + 1 WHERE username = ?').run(username);
  },
  /** 获取 token 校验所需的全量版本快照: { username: user_version } */
  getAllVersions(): Map<string, number> {
    const rows = db.prepare('SELECT username, COALESCE(user_version,1) AS user_version FROM users').all() as Array<{ username: string; user_version: number }>;
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.username, r.user_version);
    return m;
  },
  create(username: string, hash: string, role: number, note: string): boolean {
    try {
      db.prepare(
        'INSERT INTO users (username, password_hash, role, note, must_change_pwd, user_version, created_at, created_ts) VALUES (?, ?, ?, ?, 0, 1, ?, ?)'
      ).run(username, hash, role, note, nowReadable(), nowTs());
      return true;
    } catch {
      return false; // 用户名重复等
    }
  },
  remove(username: string): boolean {
    return db.prepare('DELETE FROM users WHERE username = ?').run(username).changes > 0;
  },
};

// ============================================================
// 配置 KV（用于持久化 token 签名密钥等）
// ============================================================
export const configStore = {
  get(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  },
  set(key: string, value: string, note?: string): void {
    db.prepare('INSERT INTO config (key, value, note) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, note = excluded.note').run(key, value, note ?? '');
  },
};