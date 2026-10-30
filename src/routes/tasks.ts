import { Router, Request, Response } from 'express';
import { taskLogsStore } from '../store.js';

export function createTasksRouter(): Router {
  const router = Router();

  // GET /api/v1/tasks — 查询进行中任务
  router.get('/api/v1/tasks', (_req: Request, res: Response) => {
    const tasks = taskLogsStore.listActive();
    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: '',
      linkid: '',
      data: {
        total: tasks.length,
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          linkid: t.linkid,
          interface_path: t.path,
          status: t.status,
          callback_url: t.callback_url,
          created_at: t.created_at,
        })),
      },
    });
  });

  // DELETE /api/v1/tasks/:task_id — 取消任务
  router.delete('/api/v1/tasks/:task_id', (req: Request, res: Response) => {
    const { task_id } = req.params;
    const task = taskLogsStore.get(task_id);

    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在或已结束', task_id: '', linkid: '' });
      return;
    }
    if (task.status !== 'pending') {
      res.json({ code: 1001, message: '任务正在处理中，无法取消', task_id, linkid: task.linkid || '' });
      return;
    }

    taskLogsStore.updateStatus(task_id, 'cancelled');
    res.json({ code: 0, message: '任务已取消', task_id, linkid: task.linkid || '' });
  });

  // GET /api/v1/task/trace?taskid=xxx — 任务追踪
  router.get('/api/v1/task/trace', (req: Request, res: Response) => {
    const taskId = typeof req.query.taskid === 'string' ? req.query.taskid : '';
    if (!taskId) {
      res.status(400).json({ code: 1001, message: '缺少 taskid 参数', task_id: '', linkid: '' });
      return;
    }

    const task = taskLogsStore.get(taskId);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: task.task_id,
      linkid: task.linkid,
      data: {
        task_id: task.task_id,
        linkid: task.linkid,
        path: task.path,
        status: task.status,
        request_body: safeParse(task.request_body),
        prompt: task.prompt,
        sdk_output: task.sdk_output,
        callback_body: safeParse(task.callback_body),
        error_message: task.error_message,
        created_at: task.created_at,
        finished_at: task.finished_at,
      },
    });
  });

  // GET /api/v1/task/stream?taskid=xxx — 实时流式输出
  router.get('/api/v1/task/stream', (req: Request, res: Response) => {
    const taskId = typeof req.query.taskid === 'string' ? req.query.taskid : '';
    if (!taskId) {
      res.status(400).json({ code: 1001, message: '缺少 taskid 参数', task_id: '', linkid: '' });
      return;
    }

    const task = taskLogsStore.get(taskId);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    const stream = taskLogsStore.getStream(taskId);
    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: task.task_id,
      linkid: task.linkid,
      data: { status: task.status, stream },
    });
  });

  return router;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}