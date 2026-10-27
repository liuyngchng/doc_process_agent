import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { interfacesStore, taskLogsStore } from '../store.js';
import { renderPrompt } from '../services/prompt-engine.js';
import { runAgent } from '../services/sdk-runner.js';
import { getLogger } from '../logger.js';
import type { Config } from '../config.js';
import type { TaskLog, TaskStatus } from '../types.js';

const log = getLogger();

export function createAdminRouter(cfg: Config): Router {
  const router = Router();

  // ---- 接口管理 ----

  // 列表
  router.get('/admin/interfaces', (_req: Request, res: Response) => {
    const list = interfacesStore.list();
    res.json({ code: 0, data: list });
  });

  // 获取单个
  router.get('/admin/interfaces/:id', (req: Request, res: Response) => {
    const iface = interfacesStore.get(req.params.id);
    if (!iface) {
      res.status(404).json({ code: 1001, message: '接口不存在' });
      return;
    }
    res.json({ code: 0, data: iface });
  });

  // 创建
  router.post('/admin/interfaces', (req: Request, res: Response) => {
    const { name, path, prompt } = req.body as { name?: string; path?: string; prompt?: string };
    if (!name || !path || !prompt) {
      res.status(400).json({ code: 1001, message: '缺少 name / path / prompt' });
      return;
    }

    // 检查 path 唯一性
    const existing = interfacesStore.getByPath(path);
    if (existing) {
      res.status(400).json({ code: 1001, message: '接口 path 已存在: ' + path });
      return;
    }

    const created = interfacesStore.create(name, path, prompt);
    log.info({ name, path }, 'interface_created');
    res.json({ code: 0, data: created });
  });

  // 更新
  router.put('/admin/interfaces/:id', (req: Request, res: Response) => {
    const { name, path, prompt } = req.body as { name?: string; path?: string; prompt?: string };
    if (!name || !path || !prompt) {
      res.status(400).json({ code: 1001, message: '缺少 name / path / prompt' });
      return;
    }

    const updated = interfacesStore.update(req.params.id, name, path, prompt);
    if (!updated) {
      res.status(404).json({ code: 1001, message: '接口不存在' });
      return;
    }

    log.info({ name, path }, 'interface_updated');
    res.json({ code: 0, data: updated });
  });

  // 删除
  router.delete('/admin/interfaces/:id', (req: Request, res: Response) => {
    const ok = interfacesStore.remove(req.params.id);
    if (!ok) {
      res.status(404).json({ code: 1001, message: '接口不存在' });
      return;
    }
    log.info({ id: req.params.id }, 'interface_deleted');
    res.json({ code: 0, message: '已删除' });
  });

  // ---- 模拟操作 ----

  router.post('/admin/simulate', (req: Request, res: Response) => {
    const { interface_path, linkid: reqLinkid, request_body } = req.body as {
      interface_path?: string;
      linkid?: string;
      request_body?: Record<string, unknown>;
    };

    if (!interface_path) {
      res.status(400).json({ code: 1001, message: '缺少 interface_path' });
      return;
    }

    const iface = interfacesStore.getByPath(interface_path);
    if (!iface) {
      res.status(404).json({ code: 1001, message: '接口不存在: ' + interface_path });
      return;
    }

    if (!request_body || typeof request_body !== 'object') {
      res.status(400).json({ code: 1001, message: '请求体不能为空' });
      return;
    }

    const taskId = uuid();
    const linkid = reqLinkid || 'sim-' + taskId.slice(0, 8);
    const now = new Date().toISOString();

    // 持久化 task_log
    const logEntry: TaskLog = {
      task_id: taskId,
      linkid,
      path: iface.path,
      interface_id: iface.id,
      status: 'pending',
      request_body: JSON.stringify(request_body),
      prompt: '',
      sdk_output: null,
      sdk_trace: null,
      callback_body: null,
      callback_url: '',  // 模拟操作不回調
      error_message: null,
      created_at: now,
      finished_at: null,
    };
    taskLogsStore.create(logEntry);

    log.info({ taskId, linkid, path: iface.path }, 'simulate_task_created');

    // 立即返回
    res.json({ code: 0, message: '任务已创建', task_id: taskId, linkid });

    // 后台异步执行
    (async () => {
      try {
        taskLogsStore.updateStatus(taskId, 'processing');
        log.info({ taskId }, 'simulate_task_processing');

        const rendered = renderPrompt(iface.prompt, request_body);
        taskLogsStore.updateResult(taskId, { prompt: rendered });

        const result = await runAgent(taskId, rendered, cfg);

        if (!result.success) {
          taskLogsStore.updateResult(taskId, {
            status: 'failed' as TaskStatus,
            sdk_output: result.rawOutput,
            sdk_trace: result.trace,
            error_message: result.errorMessage || 'Claude 处理失败',
            finished_at: new Date().toISOString(),
          });
          log.error({ taskId, error: result.errorMessage }, 'simulate_task_failed');
        } else {
          taskLogsStore.updateResult(taskId, {
            status: 'success' as TaskStatus,
            sdk_output: result.rawOutput,
            sdk_trace: result.trace,
            finished_at: new Date().toISOString(),
          });
          log.info({ taskId, outputLen: result.rawOutput.length }, 'simulate_task_success');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        taskLogsStore.updateResult(taskId, {
          status: 'failed' as TaskStatus,
          error_message: errMsg,
          finished_at: new Date().toISOString(),
        });
        log.error({ taskId, error: errMsg }, 'simulate_task_exception');
      }
    })();
  });

  // ---- 任务日志 ----

  // 列表
  router.get('/admin/tasks', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 100, 500);
    const list = taskLogsStore.list(limit);
    res.json({ code: 0, data: list.map((t) => ({
      task_id: t.task_id,
      linkid: t.linkid,
      path: t.path,
      status: t.status,
      callback_url: t.callback_url,
      error_message: t.error_message,
      created_at: t.created_at,
      finished_at: t.finished_at,
    })) });
  });

  // 详情
  router.get('/admin/tasks/:task_id', (req: Request, res: Response) => {
    const task = taskLogsStore.get(req.params.task_id);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在' });
      return;
    }
    res.json({ code: 0, data: {
      ...task,
      request_body: safeParse(task.request_body),
      callback_body: safeParse(task.callback_body),
      sdk_trace: safeParse(task.sdk_trace),
    }});
  });

  return router;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}