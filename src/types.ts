// ============================================================
// 接口（path + 提示词模板）
// ============================================================
export interface AgentInterface {
  id: string;
  name: string;
  path: string;
  prompt: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// 任务状态
// ============================================================
export type TaskStatus =
  | 'pending'
  | 'processing'
  | 'success'
  | 'failed'
  | 'completed'
  | 'callback_fail'
  | 'cancelled';

// ============================================================
// 任务日志
// ============================================================
export interface TaskLog {
  task_id: string;
  linkid: string;
  path: string;
  interface_id: string | null;
  status: TaskStatus;
  request_body: string;
  prompt: string;
  sdk_output: string | null;
  sdk_trace: string | null;
  callback_body: string | null;
  callback_url: string;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

// ============================================================
// API 响应信封
// ============================================================
export interface ApiResponse<T = unknown> {
  code: number;
  timestamp: string;
  message: string;
  task_id: string;
  linkid: string;
  data: T;
}

// ============================================================
// 请求体（最小约束）
// ============================================================
export interface ProcessRequest {
  linkid: string;
  callback_url: string;
  [key: string]: unknown;
}

// ============================================================
// 任务队列项
// ============================================================
export interface QueueItem {
  task_id: string;
  path: string;
  iface: AgentInterface;
  body: ProcessRequest;
}

// ============================================================
// 用户
// ============================================================
export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: number;          // 1 = admin, 0 = normal
  note: string;
  must_change_pwd: boolean;
  created_at: string;
}