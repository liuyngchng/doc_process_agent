/**
 * 异步任务队列
 *
 * 基于 Promise 的轻量内存队列，配合 SQLite 持久化状态。
 */
import { v4 as uuid } from 'uuid';
import { getLogger } from '../logger.js';
import { taskLogsStore, interfacesStore } from '../store.js';
import { renderPrompt } from './prompt-engine.js';
import { runAgent } from './sdk-runner.js';
import { deliverCallback } from './callback.js';
import { nowReadable, nowTs } from '../time.js';
import type { Config } from '../config.js';
import type { AgentInterface, ProcessRequest, TaskLog, TaskStatus } from '../types.js';

const log = getLogger();

type WorkerFn = (item: { task_id: string; path: string; iface: AgentInterface; body: ProcessRequest }) => Promise<void>;

let cfg: Config;
let worker: WorkerFn;
let running = 0;
const pending: Array<{ task_id: string; path: string; iface: AgentInterface; body: ProcessRequest }> = [];

function nowLocal(): string {
  return nowReadable();
}

async function processItem(item: {
  task_id: string;
  path: string;
  iface: AgentInterface;
  body: ProcessRequest;
}): Promise<void> {
  const { task_id, path: interfacePath, iface, body } = item;

  // 状态 → processing
  taskLogsStore.updateStatus(task_id, 'processing');
  log.info({ task_id, linkid: body.linkid, path: interfacePath }, 'task_processing');

  // 渲染提示词
  const rendered = renderPrompt(iface.prompt, body as unknown as Record<string, unknown>);
  taskLogsStore.updateResult(task_id, { prompt: rendered });

  // 调用 Claude Code Agent SDK
  const result = await runAgent(task_id, rendered, cfg, (entries) => {
    taskLogsStore.appendStream(task_id, entries);
  });

  if (!result.success) {
    // LLM 调用本身失败
    const errMsg = result.errorMessage || 'Claude 处理失败';
    taskLogsStore.updateResult(task_id, {
      status: 'failed' as TaskStatus,
      sdk_output: result.rawOutput,
      sdk_trace: result.trace,
      error_message: errMsg,
      finished_at: nowLocal(),
    });

    const failPayload = buildResponse(5000, errMsg, task_id, body.linkid, null);
    const cbResult = await deliverCallback(body.callback_url, failPayload, cfg, (entries) => {
      taskLogsStore.appendStream(task_id, entries);
    });
    taskLogsStore.updateResult(task_id, {
      status: 'failed' as TaskStatus,
      callback_body: cbResult.body,
      callback_response: cbResult.responseBody,
    });
    log.error({ task_id, error: errMsg }, 'task_failed');
    return;
  }

  // LLM 成功 — 暂不修改 status，等回调完成再统一设
  taskLogsStore.updateResult(task_id, {
    sdk_output: result.rawOutput,
    sdk_trace: result.trace,
  });

  // 尝试解析 Claude 输出的 JSON
  let parsedData: unknown;
  try {
    parsedData = extractJson(result.rawOutput);
  } catch {
    // 解析失败，用 raw 字符串
    parsedData = { raw_output: result.rawOutput };
  }

  // 回调
  const successPayload = buildResponse(0, 'success', task_id, body.linkid, parsedData);
  const cbResult = await deliverCallback(body.callback_url, successPayload, cfg, (entries) => {
    taskLogsStore.appendStream(task_id, entries);
  });

  const finalStatus: TaskStatus = cbResult.success ? 'completed' : 'callback_fail';
  taskLogsStore.updateResult(task_id, {
    status: finalStatus,
    callback_body: cbResult.body,
    callback_response: cbResult.responseBody,
    finished_at: nowLocal(),
    ...(cbResult.errorMsg ? { error_message: cbResult.errorMsg } : {}),
  });

  log.info({ task_id, status: finalStatus }, 'task_done');
}

async function pump(): Promise<void> {
  const maxConcurrent = cfg.sys.max_concurrent_tasks;
  const maxPending = cfg.sys.max_pending_tasks;
  while (running < maxConcurrent && pending.length > 0) {
    const item = pending.shift()!;
    // 检查是否超过总上限
    if (running >= maxPending) {
      pending.unshift(item); // 放回去
      break;
    }
    running++;
    // fire and forget — 不阻塞后续任务入队
    processItem(item).finally(() => {
      running--;
      // 队列中还有任务且有空位，继续消费
      if (pending.length > 0 && running < maxConcurrent) {
        pump().catch(() => {});
      }
    });
  }
}

export function initTaskQueue(c: Config): void {
  cfg = c;
  worker = processItem;
  recoverOrphanedTasks();
}

/** 启动时恢复上次未完成的任务 */
function recoverOrphanedTasks(): void {
  const active = taskLogsStore.listActive();
  if (active.length === 0) return;

  let resumed = 0;
  let killed = 0;

  for (const task of active) {
    if (task.status === 'pending') {
      // 排队中 → 重新入队
      const iface = interfacesStore.get(task.interface_id || '');
      if (!iface) {
        // 找不到接口定义，标记失败
        taskLogsStore.updateResult(task.task_id, {
          status: 'failed' as TaskStatus,
          error_message: '服务重启：关联的接口模板已被删除',
          finished_at: nowLocal(),
          finished_ts: nowTs(),
        });
        killed++;
        continue;
      }

      let body: ProcessRequest;
      try { body = JSON.parse(task.request_body); } catch { continue; }

      pending.push({ task_id: task.task_id, path: task.path, iface, body });
      resumed++;
    } else if (task.status === 'processing') {
      // 处理中 → 进程已死，标记失败
      taskLogsStore.updateResult(task.task_id, {
        status: 'failed' as TaskStatus,
        error_message: '服务重启：任务被中断（原进程已退出）',
        finished_at: nowLocal(),
        finished_ts: nowTs(),
      });
      killed++;
    }
  }

  log.info({ resumed, killed }, 'task_queue_recovered');

  // 恢复后立刻触发消费
  if (pending.length > 0) pump().catch(() => {});
}

export function enqueue(iface: AgentInterface, body: ProcessRequest): { task_id: string } {
  const taskId = uuid();
  const now = nowLocal();

  // 持久化
  const logEntry: TaskLog = {
    task_id: taskId,
    linkid: body.linkid,
    path: iface.path,
    interface_id: iface.id,
    status: 'pending',
    request_body: JSON.stringify(body),
    request_response: null,
    prompt: '',
    sdk_output: null,
    sdk_trace: null,
    sdk_stream: null,
    callback_body: null,
    callback_response: null,
    callback_url: body.callback_url,
    error_message: null,
    created_at: now,
    finished_at: null,
    created_ts: nowTs(),
    finished_ts: null,
  };
  taskLogsStore.create(logEntry);

  // 入队
  pending.push({ task_id: taskId, path: iface.path, iface, body });

  // 触发消费
  pump().catch(() => {});

  return { task_id: taskId };
}

export function getRunningCount(): number {
  return running;
}

export function getPendingCount(): number {
  return pending.length;
}

// ============================================================
// helpers
// ============================================================

/** 从 Claude 输出中提取 JSON 对象 */
function extractJson(text: string): unknown {
  // 尝试提取 ```json 代码块
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) return JSON.parse(jsonBlock[1].trim());

  // 尝试提取 ``` 代码块（无语言标注）
  const codeBlock = text.match(/```\s*([\s\S]*?)```/);
  if (codeBlock) return JSON.parse(codeBlock[1].trim());

  // 尝试直接解析整个文本
  return JSON.parse(text.trim());
}

function buildResponse(
  code: number,
  message: string,
  taskId: string,
  linkid: string,
  data: unknown,
) {
  return {
    code,
    timestamp: nowReadable(),
    message,
    task_id: taskId,
    linkid,
    data: data ?? {},
  };
}