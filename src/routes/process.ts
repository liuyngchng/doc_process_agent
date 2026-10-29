import { Router, Request, Response } from 'express';
import { interfacesStore, taskLogsStore } from '../store.js';
import { enqueue, getRunningCount, getPendingCount } from '../services/task-queue.js';
import { getLogger } from '../logger.js';
import type { ProcessRequest } from '../types.js';
import type { Config } from '../config.js';

const log = getLogger();

export function createProcessRouter(cfg: Config): Router {
  const router = Router();

  // POST /api/v1/:path — 通配路由，path 可以是 document/classify 等任意路径
  router.post('/api/v1/*', (req: Request, res: Response) => {
    const interfacePath = req.params[0] || '';
    if (!interfacePath) {
      log.warn({ body: req.body }, 'request_missing_path');
      res.status(404).json(buildResponse(1001, '缺少接口路径', '', ''));
      return;
    }

    // 查找接口定义
    const iface = interfacesStore.getByPath(interfacePath);
    if (!iface) {
      log.warn({ path: interfacePath }, 'request_interface_not_found');
      res.status(404).json(buildResponse(1001, '接口不存在: ' + interfacePath, '', ''));
      return;
    }

    const body = req.body as ProcessRequest;
    if (!body || typeof body !== 'object') {
      log.warn({ rawBody: req.body }, 'request_empty_body');
      res.status(400).json(buildResponse(1001, '请求体不能为空', '', ''));
      return;
    }
    if (!body.linkid) {
      log.warn({ body: req.body }, 'request_missing_linkid');
      res.status(400).json(buildResponse(1001, '缺少 linkid', '', ''));
      return;
    }
    if (!body.callback_url) {
      log.warn({ body: req.body }, 'request_missing_callback_url');
      res.status(400).json(buildResponse(1001, '缺少 callback_url', '', ''));
      return;
    }

    // 检查队列上限
    const maxPending = cfg.sys.max_pending_tasks;
    const activeCount = getRunningCount() + getPendingCount();
    if (activeCount >= maxPending) {
      const msg = '任务队列已满，当前处理中任务数 ' + activeCount + '/' + maxPending +
        '（最大并发 ' + cfg.sys.max_concurrent_tasks + '，最大排队 ' + maxPending + '），请稍后重试';
      log.warn({ linkid: body.linkid, path: interfacePath, activeCount, maxPending }, 'request_queue_full');
      res.status(503).json(buildResponse(2002, msg, '', body.linkid));
      return;
    }

    // 入队
    const { task_id } = enqueue(iface, body);

    log.info({ task_id, linkid: body.linkid, path: interfacePath }, 'task_enqueued');
    res.json(buildResponse(0, 'success', task_id, body.linkid));
  });

  return router;
}

function buildResponse(code: number, message: string, taskId: string, linkid: string) {
  return {
    code,
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    message,
    task_id: taskId,
    linkid,
    data: {},
  };
}