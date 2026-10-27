import Database from 'better-sqlite3';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import type { AgentInterface, TaskLog, TaskStatus, User } from './types.js';

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
      updated_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      task_id       TEXT PRIMARY KEY,
      linkid        TEXT,
      path          TEXT,
      interface_id  TEXT,
      status        TEXT,
      request_body  TEXT,
      prompt        TEXT,
      sdk_output    TEXT,
      sdk_trace     TEXT,
      callback_body TEXT,
      callback_url  TEXT,
      error_message TEXT,
      created_at    TEXT,
      finished_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      role            INTEGER DEFAULT 0,
      note            TEXT DEFAULT '',
      must_change_pwd INTEGER DEFAULT 0,
      created_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      note  TEXT
    );
  `);
  // Migration: add sdk_trace column if missing (added in v0.1.x)
  try { db.exec(`ALTER TABLE task_logs ADD COLUMN sdk_trace TEXT`); } catch { /* already exists */ }
  // Migration: add users / config tables if missing (added in v0.2.x)
  try { db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role INTEGER DEFAULT 0, note TEXT DEFAULT '', must_change_pwd INTEGER DEFAULT 0, created_at TEXT)`); } catch { /* already exists */ }
  try { db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, note TEXT)`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN must_change_pwd INTEGER DEFAULT 0`); } catch { /* already exists */ }

  seedDefaults(db);
  return db;
}

export function getDb(): Database.Database {
  return db;
}

// 初始化默认接口
function seedDefaults(db: Database.Database) {
  const ifaceCount = (db.prepare('SELECT COUNT(*) AS c FROM agent_interfaces').get() as { c: number }).c;
  if (ifaceCount === 0) {
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    insert.run(uuid(), '收文分类', 'document/classify', defaultClassifyPrompt(), now, now);
    insert.run(uuid(), '流转目标识别', 'document/route', defaultRoutePrompt(), now, now);
    insert.run(uuid(), '发文审核', 'document/dispatch-review', defaultDispatchReviewPrompt(), now, now);
  }

  // 初始化默认 admin 用户（密码 admin/admin，首次登录必须改密）
  const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (userCount === 0) {
    db.prepare(
      'INSERT INTO users (username, password_hash, role, note, must_change_pwd, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('admin', hashPasswordSync('admin'), 1, '默认管理员', 1, new Date().toISOString());
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
- next_node 必须从 next_nodes / person_list / org_list 中选择已存在的节点
- 如果无法确定，将 need_human 设为 true 并在 fail_reason 中说明原因
- 不要输出任何其他内容，只输出 JSON`;
}

function defaultDispatchReviewPrompt(): string {
  return `# 发文审核任务

你需要对发文进行合规审核。以下是请求信息：

\`\`\`json
{{request.body}}
\`\`\`

## 执行步骤

### 步骤 1：下载并读取文件
遍历请求中的 \`files\` 数组，用 curl 下载文件并用 Read 工具读取。

### 步骤 2：审核
按照党政机关公文格式规范，对发文进行审核。

## 输出要求

请按以下 JSON Schema 输出最终结果，用 \`\`\`json 代码块包裹：

\`\`\`json
{
  "audit_result": "warning",
  "issues": [
    {
      "category": "体例格式",
      "desc": "",
      "severity": "low",
      "location": ""
    }
  ],
  "suggestions": []
}
\`\`\`

## 注意事项
- audit_result 取值为 pass / warning
- issues 中列出发现的问题
- 不要输出任何其他内容，只输出 JSON`;
}

// ============================================================
// 接口 CRUD
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
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO agent_interfaces (id, name, path, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, path, prompt, now, now);
    return this.get(id)!;
  },
  update(id: string, name: string, path: string, prompt: string): AgentInterface | undefined {
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE agent_interfaces SET name = ?, path = ?, prompt = ?, updated_at = ? WHERE id = ?'
    ).run(name, path, prompt, now, id);
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
       (task_id, linkid, path, interface_id, status, request_body, prompt, sdk_output, sdk_trace, callback_body, callback_url, error_message, created_at, finished_at)
       VALUES (@task_id, @linkid, @path, @interface_id, @status, @request_body, @prompt, @sdk_output, @sdk_trace, @callback_body, @callback_url, @error_message, @created_at, @finished_at)`
    ).run(log);
  },
  updateStatus(taskId: string, status: TaskStatus): void {
    db.prepare('UPDATE task_logs SET status = ? WHERE task_id = ?').run(status, taskId);
  },
  updateResult(taskId: string, fields: Partial<TaskLog>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
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
  list(limit = 100): TaskLog[] {
    return db.prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?').all(limit) as TaskLog[];
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
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  },
  list(): User[] {
    return db.prepare('SELECT id, username, password_hash, role, note, COALESCE(must_change_pwd,0) AS must_change_pwd, COALESCE(created_at,\'\') AS created_at FROM users ORDER BY id').all() as User[];
  },
  updatePassword(username: string, hash: string): boolean {
    return db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username).changes > 0;
  },
  clearMustChangePwd(username: string): boolean {
    return db.prepare('UPDATE users SET must_change_pwd = 0 WHERE username = ?').run(username).changes > 0;
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
