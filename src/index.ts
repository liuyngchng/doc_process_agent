import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig, ensureDirs } from './config.js';
import { initLogger, getLogger } from './logger.js';
import { initStore, taskLogsStore, configStore } from './store.js';
import { initTaskQueue } from './services/task-queue.js';
import { createProcessRouter } from './routes/process.js';
import { createHealthRouter } from './routes/health.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter, authWebMiddleware, apiTokenMiddleware } from './routes/auth.js';

const log = getLogger();

log.info('==== doc_process_agent starting ====');

const cfg = loadConfig();
log.info('config_loaded');

ensureDirs(cfg);
log.info({ data_dir: cfg.sys.data_dir }, 'data_dirs_ready');

// 初始化正式 logger（此后 log 代理自动指向新实例）
initLogger(cfg.sys.data_dir, cfg.server.debug);

// ---- 打印完整配置（敏感字段脱敏） ----
function mask(s: string): string {
  if (!s) return '(empty)';
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '***' + s.slice(-4);
}

log.info({
  server: cfg.server,
  sys: {
    ...cfg.sys,
    api_token: mask(cfg.sys.api_token),
    file_url_token: mask(cfg.sys.file_url_token),
  },
  llm: {
    ...cfg.llm,
    auth_token: mask(cfg.llm.auth_token),
  },
  doc_audit: {
    ...cfg.doc_audit,
    token: mask(cfg.doc_audit.token),
  },
}, 'config_loaded');

// 初始化存储
initStore(cfg.sys.data_dir);
log.info('store_ready');

// 初始化任务队列
initTaskQueue(cfg);
log.info('task_queue_ready');

// Express
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
log.info('express_routes_registering');

// ============================================================
// 公开路由（无需认证）
// ============================================================
app.use(createHealthRouter());

// 认证 API（登录/登出/改密）
app.use(createAuthRouter());

// 登录页面
app.get('/login', (_req, res) => {
  res.sendFile('login.html', { root: 'web' });
});

// 公开系统信息（登录页用，无需认证）
app.get('/api/info', (_req, res) => {
  const name = configStore.get('sys.name') || 'doc_process_agent';
  res.json({ code: 0, data: { sys_name: name } });
});

// 静态资源（公开，登录页也需要）
app.use('/static', express.static('web/static'));

// 对外业务接口（外部系统调用，Bearer Token 鉴权）
app.use('/api/v1', apiTokenMiddleware(cfg.sys.api_token));
app.use(createProcessRouter(cfg));

// 任务管理 API（外部系统调用）
app.use(createTasksRouter());

// Dev null — 用于调试接收请求
app.post('/api/dev/null', (req, res) => {
  log.info({ body: req.body }, 'dev_null_received');
  res.json({ status: 'ok' });
});

// ============================================================
// 以下需要登录（Web Cookie 认证）
// ============================================================
app.use(authWebMiddleware);

// 管理后台 API
app.use(createAdminRouter(cfg));

// 管理后台 Web 页面
app.get('/admin', (_req, res) => {
  res.sendFile('admin.html', { root: 'web' });
});

// 根路径重定向到管理后台
app.get('/', (_req, res) => {
  res.redirect('/admin');
});

// 启动 — 有证书则 HTTPS，否则 HTTP
const port = cfg.server.port;
const certFile = cfg.server.cert_file;
const keyFile = cfg.server.key_file;

log.info({ port, certFile: certFile || '(none)' }, 'binding_port');

// ---- 定期清理过期任务数据 ----
function cleanupExpiredTasks() {
  const retentionDays = cfg.sys.retention_days;
  try {
    const deleted = taskLogsStore.deleteExpired(retentionDays);
    // 清理已删除任务对应的磁盘工作目录
    const remainingIds = new Set(taskLogsStore.listTaskIds());
    const tasksDir = join(cfg.sys.data_dir, 'tasks');
    if (existsSync(tasksDir)) {
      for (const dir of readdirSync(tasksDir)) {
        if (!remainingIds.has(dir)) {
          rmSync(join(tasksDir, dir), { recursive: true, force: true });
        }
      }
    }
    log.info({ retentionDays, deletedRows: deleted }, 'cleanup_done');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, 'cleanup_error');
  }
}

// 启动时立即清理一次，之后每小时清理一次
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setTimeout(cleanupExpiredTasks, 10 * 1000);
setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS);
log.info({ retentionDays: cfg.sys.retention_days, intervalMs: CLEANUP_INTERVAL_MS }, 'cleanup_scheduled');

if (certFile && keyFile && existsSync(certFile) && existsSync(keyFile)) {
  const httpsOpts = {
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  };
  createHttpsServer(httpsOpts, app).listen(port, () => {
    log.info({ port, url: 'https://localhost:' + port }, 'server_started_https');
  });
} else {
  app.listen(port, () => {
    log.info({ port, url: 'http://localhost:' + port }, 'server_started_http');
  });
}