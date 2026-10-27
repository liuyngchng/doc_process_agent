import { existsSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import express from 'express';
import { loadConfig, ensureDirs } from './config.js';
import { initLogger } from './logger.js';
import { initStore } from './store.js';
import { initTaskQueue } from './services/task-queue.js';
import { createProcessRouter } from './routes/process.js';
import { createHealthRouter } from './routes/health.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAdminRouter } from './routes/admin.js';

const cfg = loadConfig();
ensureDirs(cfg);

const log = initLogger(cfg.sys.data_dir, cfg.server.debug);
log.info({ config: cfg.server }, 'starting');

// 初始化存储
initStore(cfg.sys.data_dir);

// 初始化任务队列
initTaskQueue(cfg);
log.info('task_queue_ready');

// Express
const app = express();
app.use(express.json({ limit: '10mb' }));

// 公开路由（无需认证）
app.use(createHealthRouter());

// 对外业务接口（无需认证，先跑通功能）
app.use(createProcessRouter(cfg));

// 任务管理
app.use(createTasksRouter());

// 管理后台 API
app.use(createAdminRouter());

// 管理后台 Web 页面
app.get('/admin', (_req, res) => {
  res.sendFile('admin.html', { root: 'web' });
});
app.use('/static', express.static('web'));

// 根路径重定向到管理后台
app.get('/', (_req, res) => {
  res.redirect('/admin');
});

// Dev null — 用于调试接收请求
app.post('/api/dev/null', (req, res) => {
  log.info({ body: req.body }, 'dev_null_received');
  res.json({ status: 'ok' });
});

// 启动 — 有证书则 HTTPS，否则 HTTP
const port = cfg.server.port;
const certFile = cfg.server.cert_file;
const keyFile = cfg.server.key_file;

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