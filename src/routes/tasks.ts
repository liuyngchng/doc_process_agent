import { Router, Request, Response } from 'express';
import { taskLogsStore } from '../store.js';
import { getLogger } from '../logger.js';
import type { TaskLog, StreamEntry } from '../types.js';

const log = getLogger();

export function createTasksRouter(): Router {
  const router = Router();

  // GET /api/v1/tasks — 查询进行中任务
  router.get('/api/v1/tasks', (_req: Request, res: Response) => {
    const tasks = taskLogsStore.listActive();
    log.info({ count: tasks.length }, 'api_list_tasks');
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
      log.warn({ task_id }, 'api_cancel_task_not_found');
      res.status(404).json({ code: 1001, message: '任务不存在或已结束', task_id: '', linkid: '' });
      return;
    }
    if (task.status !== 'pending') {
      log.warn({ task_id, status: task.status, linkid: task.linkid }, 'api_cancel_task_rejected');
      res.json({ code: 1001, message: '任务正在处理中，无法取消', task_id, linkid: task.linkid || '' });
      return;
    }

    taskLogsStore.updateStatus(task_id, 'cancelled');
    log.info({ task_id, linkid: task.linkid }, 'api_cancel_task_ok');
    res.json({ code: 0, message: '任务已取消', task_id, linkid: task.linkid || '' });
  });

  // GET /api/v1/task/trace?taskid=xxx — 任务追踪
  router.get('/api/v1/task/trace', (req: Request, res: Response) => {
    const taskId = typeof req.query.taskid === 'string' ? req.query.taskid : '';
    if (!taskId) {
      log.warn({}, 'api_task_trace_missing_taskid');
      res.status(400).json({ code: 1001, message: '缺少 taskid 参数', task_id: '', linkid: '' });
      return;
    }

    const task = taskLogsStore.get(taskId);
    if (!task) {
      log.warn({ task_id: taskId }, 'api_task_trace_not_found');
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    log.info({ task_id: taskId, linkid: task.linkid, status: task.status }, 'api_task_trace');
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
      log.warn({}, 'api_task_stream_missing_taskid');
      res.status(400).json({ code: 1001, message: '缺少 taskid 参数', task_id: '', linkid: '' });
      return;
    }

    const task = taskLogsStore.get(taskId);
    if (!task) {
      log.warn({ task_id: taskId }, 'api_task_stream_not_found');
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    const stream = taskLogsStore.getStream(taskId);
    log.info({ task_id: taskId, linkid: task.linkid, status: task.status, entries: stream.length }, 'api_task_stream');
    res.json({
      code: 0,
      timestamp: now(),
      message: 'success',
      task_id: task.task_id,
      linkid: task.linkid,
      data: { status: task.status, stream },
    });
  });

  // GET /api/v1/task/log/:task_id?format=json|html — 任务审计日志时间线
  router.get('/api/v1/task/log/:task_id', (req: Request, res: Response) => {
    const { task_id } = req.params;
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'json';

    const task = taskLogsStore.get(task_id);
    if (!task) {
      log.warn({ task_id }, 'api_task_log_not_found');
      if (format === 'html') {
        res.status(404).contentType('text/html; charset=utf-8').send(
          htmlPage('任务不存在', '', '', '', '', null, null, '', [])
        );
        return;
      }
      res.status(404).json({ code: 1001, message: '任务不存在', task_id: '', linkid: '' });
      return;
    }

    const stream = taskLogsStore.getStream(task_id);
    const events = buildTimelineEvents(task, stream);
    const linkid = task.linkid || '';

    log.info({ task_id, linkid, status: task.status, format, events: events.length }, 'api_task_log');

    if (format === 'html') {
      res.contentType('text/html; charset=utf-8').send(
        renderTimelineHtml(task, events, linkid)
      );
      return;
    }

    // 默认 JSON
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
        callback_url: task.callback_url,
        error_message: task.error_message,
        created_at: task.created_at,
        finished_at: task.finished_at,
        timeline: events,
      },
    });
  });

  return router;
}

// ============================================================
// 时间线事件构建
// ============================================================

interface TimelineEvent {
  time: string | null;
  type: string;
  title: string;
  detail: string;
}

function buildTimelineEvents(task: TaskLog, stream: StreamEntry[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 1. 任务创建
  events.push({
    time: task.created_at,
    type: 'create',
    title: '任务创建',
    detail: '接口: ' + (task.path || '-'),
  });

  // 2. 收到请求数据
  if (task.request_body) {
    events.push({
      time: task.created_at,
      type: 'input',
      title: '收到请求数据',
      detail: jsonFmt(task.request_body),
    });
  }

  // 3. 我方响应
  if (task.request_response) {
    events.push({
      time: task.created_at,
      type: 'output',
      title: '返回同步响应',
      detail: jsonFmt(task.request_response),
    });
  }

  // 4. 渲染提示词
  if (task.prompt) {
    events.push({
      time: task.created_at,
      type: 'prompt',
      title: '渲染提示词',
      detail: task.prompt,
    });
  }

  // 5. 智能体执行过程（流式）
  for (const entry of stream) {
    const label =
      entry.type === 'tool' ? '调用工具 ' + (entry.tool_name || '') :
      entry.type === 'tool_result' ? '工具返回' :
      entry.type === 'system' ? '系统消息' :
      entry.type === 'error' ? '错误' :
      '智能体输出';
    let detail = entry.text || '';
    if (entry.tool_input) detail += '\n\n---- 工具输入 ----\n' + entry.tool_input;
    if (entry.tool_output) detail += '\n\n---- 工具输出 ----\n' + entry.tool_output;
    events.push({
      time: entry.ts || null,
      type: entry.type || 'text',
      title: label,
      detail,
    });
  }

  // 6. Agent 最终输出
  if (task.sdk_output) {
    events.push({
      time: task.finished_at,
      type: 'output',
      title: 'Agent 输出结果',
      detail: task.sdk_output,
    });
  }

  // 7. 回调对方 URL
  if (task.callback_url) {
    let detail = 'POST ' + task.callback_url;
    if (task.callback_body) {
      detail += '\n\n回调体:\n' + jsonFmt(task.callback_body);
    }
    if (task.callback_response) {
      detail += '\n\n回调响应:\n' + jsonFmt(task.callback_response);
    }
    events.push({
      time: task.finished_at,
      type: 'callback',
      title: '回调对方 URL',
      detail,
    });
  }

  // 8. 完成 / 失败
  const finalTitle =
    task.status === 'completed' || task.status === 'success' ? '任务完成' :
    task.status === 'failed' ? '任务失败' :
    task.status === 'callback_fail' ? '回调失败' :
    task.status === 'cancelled' ? '任务已取消' :
    '状态: ' + task.status;
  const finalType =
    task.status === 'completed' || task.status === 'success' ? 'done' :
    task.status === 'failed' || task.status === 'callback_fail' ? 'error' :
    'info';
  events.push({
    time: task.finished_at,
    type: finalType,
    title: finalTitle,
    detail: task.error_message || '',
  });

  return events;
}

// ============================================================
// HTML 时间线页面渲染
// ============================================================

function renderTimelineHtml(task: TaskLog, events: TimelineEvent[], linkid: string): string {
  const itemsHtml = events.map(ev => {
    const timeStr = ev.time ? fmtTs(ev.time) : '';
    const icon = ev.type === 'callback' ? '📤' :
      ev.type === 'tool' ? '🔧' :
      ev.type === 'input' ? '📥' :
      ev.type === 'output' ? '📤' :
      ev.type === 'done' ? '✅' :
      ev.type === 'error' ? '❌' :
      ev.type === 'create' ? '➕' :
      ev.type === 'prompt' ? '📝' :
      '🔵';
    const detailBlock = ev.detail
      ? `<pre class="detail">${escHtml(ev.detail)}</pre>`
      : '';
    return `<div class="item ${ev.type}">
        <div class="dot">${icon}</div>
        <div class="body">
          <div class="ihead"><span class="time">${escHtml(timeStr)}</span><strong>${escHtml(ev.title)}</strong></div>
          ${detailBlock}
        </div>
      </div>`;
  }).join('\n');

  return htmlPage(
    '数据处理时间线 — ' + escHtml(linkid || task.task_id?.substring(0, 8) || ''),
    task.task_id,
    linkid || task.task_id?.substring(0, 8) || '',
    task.path || '-',
    task.status,
    task.created_at,
    task.finished_at,
    itemsHtml,
    events
  );
}

function htmlPage(
  title: string,
  taskId: string,
  linkid: string,
  path: string,
  status: string,
  createdAt: string | null,
  finishedAt: string | null,
  itemsHtml: string,
  _events: TimelineEvent[]
): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;background:#f5f6fa;color:#333;padding:40px 20px}
.wrap{max-width:960px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);overflow:hidden}
.page-head{padding:28px 36px;background:linear-gradient(to right,#4b6cb7,#182848);color:#fff}
.page-head h1{font-size:1.4rem;display:flex;align-items:center;gap:10px}
.page-head .meta{margin-top:10px;font-size:.85rem;opacity:.85;display:flex;flex-wrap:wrap;gap:16px}
.page-head .meta span{display:inline-flex;align-items:center;gap:4px}
.page-head .badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:.78rem;font-weight:600;background:rgba(255,255,255,.25)}
.tl{padding:28px 36px}
.item{display:flex;gap:14px;padding:14px 0;border-left:2px solid #e0e0e0;margin-left:8px;position:relative}
.item:last-child{border-left-color:transparent}
.dot{width:28px;height:28px;border-radius:50%;background:#667eea;flex-shrink:0;margin-left:-15px;display:flex;align-items:center;justify-content:center;font-size:.85rem;position:relative;z-index:1}
.item.error .dot{background:#e53e3e}
.item.done .dot{background:#38a169}
.item.callback .dot{background:#3182ce}
.item.create .dot{background:#805ad5}
.item.prompt .dot{background:#d69e2e}
.item.output .dot{background:#319795}
.item.input .dot{background:#dd6b20}
.item.tool .dot{background:#2b6cb0}
.item.tool_result .dot{background:#718096}
.item.system .dot{background:#a0aec0}
.body{flex:1;min-width:0}
.ihead{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:.92rem}
.time{font-family:monospace;font-size:.78rem;color:#888;white-space:nowrap}
.detail{background:#f7f8fa;border-radius:6px;padding:12px 16px;margin-top:8px;font-size:.82rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow:auto;border:1px solid #edf2f7}
.foot{padding:16px 36px;border-top:1px solid #edf2f7;font-size:.78rem;color:#999;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <div class="page-head">
    <h1>&#129302; 数据处理时间线</h1>
    <div class="meta">
      <span>LinkID: ${escHtml(linkid)}</span>
      <span>Task ID: ${escHtml(taskId?.substring(0, 18) || '-')}...</span>
      <span>接口: ${escHtml(path)}</span>
      <span class="badge">${escHtml(status)}</span>
      <span>${fmtTs(createdAt)} ~ ${fmtTs(finishedAt)}</span>
    </div>
  </div>
  <div class="tl">${itemsHtml}</div>
  <div class="foot">Powered by dp_agt</div>
</div>
</body>
</html>`;
}

// ============================================================
// helpers
// ============================================================

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function jsonFmt(v: unknown): string {
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  return JSON.stringify(v, null, 2);
}

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function escHtml(s: string | null): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTs(s: string | null): string {
  if (!s) return '-';
  if (/^\d{2}:\d{2}:\d{2}/.test(s)) return s; // HH:MM:ss.SSS
  try {
    const d = new Date(s);
    const p = (n: number) => String(n).padStart(2, '0');
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  } catch {
    return s;
  }
}