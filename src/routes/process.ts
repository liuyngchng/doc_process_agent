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

    // 第一时间打印收到的请求数据（无论对错）
    log.debug({ path: interfacePath, body: req.body }, 'request_received');

    if (!interfacePath) {
      const resp = buildResponse(1001, '缺少接口路径', '', '');
      log.warn({ request: req.body, response: resp }, 'request_missing_path');
      res.status(404).json(resp);
      return;
    }

    // 查找接口定义
    const iface = interfacesStore.getByPath(interfacePath);
    if (!iface) {
      const resp = buildResponse(1001, '接口不存在: ' + interfacePath, '', '');
      log.warn({ path: interfacePath, request: req.body, response: resp }, 'request_interface_not_found');
      res.status(404).json(resp);
      return;
    }

    const body = req.body as ProcessRequest;
    if (!body || typeof body !== 'object') {
      const resp = buildResponse(1001, '请求体不能为空', '', '');
      log.warn({ rawBody: req.body, request: req.body, response: resp }, 'request_empty_body');
      res.status(400).json(resp);
      return;
    }
    if (!body.linkid) {
      const resp = buildResponse(1001, '缺少 linkid', '', '');
      log.warn({ request: req.body, response: resp }, 'request_missing_linkid');
      res.status(400).json(resp);
      return;
    }
    if (!body.callback_url) {
      const resp = buildResponse(1001, '缺少 callback_url', '', '');
      log.warn({ request: req.body, response: resp }, 'request_missing_callback_url');
      res.status(400).json(resp);
      return;
    }

    // 检查队列上限
    const maxPending = cfg.sys.max_pending_tasks;
    const activeCount = getRunningCount() + getPendingCount();
    if (activeCount >= maxPending) {
      const msg = '任务队列已满，当前处理中任务数 ' + activeCount + '/' + maxPending +
        '（最大并发 ' + cfg.sys.max_concurrent_tasks + '，最大排队 ' + maxPending + '），请稍后重试';
      const resp = buildResponse(2002, msg, '', body.linkid);
      log.warn({ linkid: body.linkid, path: interfacePath, activeCount, maxPending, request: body, response: resp }, 'request_queue_full');
      res.status(503).json(resp);
      return;
    }

    // 入队
    const { task_id } = enqueue(iface, body);

    const resp = buildResponse(0, 'success', task_id, body.linkid);
    // 持久化同步响应（对方调用我时，我方立即返回的 JSON）
    taskLogsStore.updateResult(task_id, { request_response: JSON.stringify(resp) });
    log.info({ task_id, linkid: body.linkid, path: interfacePath, response: resp }, 'api_request_completed');
    res.json(resp);
  });

  return router;
}

function buildResponse(code: number, message: string, taskId: string, linkid: string) {
  const resp: Record<string, unknown> = {
    code,
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    message,
  };
  // 校验失败时无 task_id / linkid，不输出空字段；成功时才带 task_id
  if (taskId) resp.task_id = taskId;
  if (linkid) resp.linkid = linkid;
  return resp;
}