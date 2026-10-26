import { Router, Request, Response } from 'express';
import { interfacesStore, taskLogsStore } from '../store.js';
import { getLogger } from '../logger.js';

const log = getLogger();

export function createAdminRouter(): Router {
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
    }});
  });

  return router;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}