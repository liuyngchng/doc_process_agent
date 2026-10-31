import { Router, Request, Response } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { interfacesStore, taskLogsStore, configStore, usersStore, hashPasswordSync } from '../store.js';
import { getLogger } from '../logger.js';
import { nowReadable } from '../time.js';
import { getCurrentUser, adminOnlyMiddleware, validatePasswordStrength } from './auth.js';
import { submitTask } from './process.js';
import type { Config } from '../config.js';

const log = getLogger();

export function createAdminRouter(cfg: Config): Router {
  const router = Router();

  // === 导航信息（所有登录用户可访问） ===
  router.get('/admin/nav', (req: Request, res: Response) => {
    const cu = getCurrentUser(req);
    const isAdmin = cu?.role === 1;
    const tabs = [
      ...(isAdmin ? [
        { id: 'interfaces', icon: 'fa-brain', label: '模板管理' },
        { id: 'simulate', icon: 'fa-flask', label: '操作模拟' },
        { id: 'tasks', icon: 'fa-list-alt', label: '任务监控' },
      ] : []),
      { id: 'audit', icon: 'fa-search', label: '任务审查' },
      ...(isAdmin ? [
        { id: 'sys', icon: 'fa-sliders-h', label: '系统设置' },
        { id: 'users', icon: 'fa-users', label: '用户管理' },
      ] : []),
    ];
    const defaultTab = isAdmin ? 'interfaces' : 'audit';
    res.json({ code: 0, data: { role: isAdmin ? 1 : 0, default_tab: defaultTab, tabs } });
  });

  // === 服务器信息（所有登录用户可访问） ===
  router.get('/admin/server-info', (_req: Request, res: Response) => {
    const protocol = cfg.server.cert_file && cfg.server.key_file &&
      existsSync(cfg.server.cert_file) && existsSync(cfg.server.key_file) ? 'https' : 'http';
    const host = cfg.server.self_ip || detectPrimaryIp();
    res.json({ code: 0, data: { protocol, host, port: cfg.server.port } });
  });

  // ============================================================
  // 以下仅管理员
  // ============================================================

  // ---- 访问路径管理 ----
  router.use('/admin/interfaces', adminOnlyMiddleware);
  router.use('/admin/mock', adminOnlyMiddleware);
  router.use('/admin/simulate', adminOnlyMiddleware);
  router.use('/admin/tasks', adminOnlyMiddleware);
  router.use('/admin/sys-config', adminOnlyMiddleware);

  // 列表
  router.get('/admin/interfaces', (_req: Request, res: Response) => {
    const list = interfacesStore.list();
    res.json({ code: 0, data: list });
  });

  // 获取单个
  router.get('/admin/interfaces/:id', (req: Request, res: Response) => {
    const iface = interfacesStore.get(req.params.id);
    if (!iface) {
      res.status(404).json({ code: 1001, message: '访问路径不存在' });
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

    const existing = interfacesStore.getByPath(path);
    if (existing) {
      res.status(400).json({ code: 1001, message: '访问路径 path 已存在: ' + path });
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
      res.status(404).json({ code: 1001, message: '访问路径不存在' });
      return;
    }

    log.info({ name, path }, 'interface_updated');
    res.json({ code: 0, data: updated });
  });

  // 删除
  router.delete('/admin/interfaces/:id', (req: Request, res: Response) => {
    const ok = interfacesStore.remove(req.params.id);
    if (!ok) {
      res.status(404).json({ code: 1001, message: '访问路径不存在' });
      return;
    }
    log.info({ id: req.params.id }, 'interface_deleted');
    res.json({ code: 0, message: '已删除' });
  });

  // ---- 模拟操作 ----

  router.get('/admin/mock', (_req: Request, res: Response) => {
    const mockFile = join(cfg.sys.data_dir, 'mock.json');
    if (!existsSync(mockFile)) {
      res.status(404).json({ code: 1001, message: 'mock.json 不存在' });
      return;
    }
    try {
      const raw = readFileSync(mockFile, 'utf8');
      const parsed = JSON.parse(raw);
      res.json({ code: 0, data: parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ code: 1001, message: 'mock.json 解析失败: ' + msg });
    }
  });

  router.post('/admin/simulate', (req: Request, res: Response) => {
    const { interface_path, request_body } = req.body as {
      interface_path?: string;
      request_body?: Record<string, unknown>;
    };

    log.debug({ path: interface_path, body: request_body }, 'simulate_request_received');

    // 对外接口完全一致的逻辑：校验接口、队列上限、入队
    const result = submitTask(interface_path || '', request_body || {}, cfg);

    if (result.status >= 400) {
      log.warn({ path: interface_path, request: request_body, response: result.body }, 'simulate_request_rejected');
    } else {
      log.info({ task_id: result.body.task_id, linkid: result.body.linkid, path: interface_path, response: result.body }, 'simulate_task_enqueued');
    }

    res.status(result.status).json(result.body);
  });

  // ---- 任务监控 ----

  router.get('/admin/tasks', (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const pageSize = Math.min(parseInt(String(req.query.page_size), 10) || 10, 100);
    const { items, total } = taskLogsStore.listPaged((page - 1) * pageSize, pageSize);
    res.json({ code: 0, data: {
      total,
      page,
      page_size: pageSize,
      items: items.map((t) => ({
        task_id: t.task_id,
        linkid: t.linkid,
        title: extractTitle(t.request_body),
        path: t.path,
        status: t.status,
        callback_url: t.callback_url,
        error_message: t.error_message,
        created_at: t.created_at,
        finished_at: t.finished_at,
      })),
    } });
  });

  router.get('/admin/tasks/:task_id', (req: Request, res: Response) => {
    const task = taskLogsStore.get(req.params.task_id);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在' });
      return;
    }
    res.json({ code: 0, data: {
      ...task,
      title: extractTitle(task.request_body),
      request_body: safeParse(task.request_body),
      request_response: safeParse(task.request_response),
      callback_body: safeParse(task.callback_body),
      callback_response: safeParse(task.callback_response),
      sdk_trace: safeParse(task.sdk_trace),
      sdk_stream: safeParse(task.sdk_stream),
    }});
  });

  router.get('/admin/tasks/:task_id/stream', (req: Request, res: Response) => {
    const task = taskLogsStore.get(req.params.task_id);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在' });
      return;
    }
    const stream = taskLogsStore.getStream(req.params.task_id);
    res.json({ code: 0, data: { status: task.status, stream } });
  });

  // ============================================================
  // 以下所有登录用户可访问
  // ============================================================

  // ---- 任务审查 ----

  router.get('/admin/audit', (req: Request, res: Response) => {
    const taskId = typeof req.query.task_id === 'string' ? req.query.task_id.trim() : '';
    const linkid = typeof req.query.linkid === 'string' ? req.query.linkid.trim() : '';
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const pageSize = Math.min(parseInt(String(req.query.page_size), 10) || 10, 100);
    const { items, total } = taskLogsStore.searchPaged(taskId, linkid, (page - 1) * pageSize, pageSize);
    res.json({
      code: 0,
      data: {
        total,
        page,
        page_size: pageSize,
        items: items.map((t) => ({
          task_id: t.task_id,
          linkid: t.linkid,
          title: extractTitle(t.request_body),
          path: t.path,
          status: t.status,
          created_at: t.created_at,
          finished_at: t.finished_at,
        })),
      },
    });
  });

  router.get('/admin/audit/:task_id', (req: Request, res: Response) => {
    const task = taskLogsStore.get(req.params.task_id);
    if (!task) {
      res.status(404).json({ code: 1001, message: '任务不存在' });
      return;
    }
    res.json({
      code: 0,
      data: {
        task_id: task.task_id,
        linkid: task.linkid,
        title: extractTitle(task.request_body),
        path: task.path,
        status: task.status,
        callback_url: task.callback_url,
        error_message: task.error_message,
        created_at: task.created_at,
        finished_at: task.finished_at,
        request_body: safeParse(task.request_body),
        request_response: safeParse(task.request_response),
        prompt: task.prompt,
        sdk_output: task.sdk_output,
        sdk_trace: safeParse(task.sdk_trace),
        sdk_stream: safeParse(task.sdk_stream),
        callback_body: safeParse(task.callback_body),
        callback_response: safeParse(task.callback_response),
      },
    });
  });

  // ---- 系统设置（仅管理员） ----

  router.get('/admin/sys-config', (req: Request, res: Response) => {
    const name = configStore.get('sys.name') || '';
    const apiAuthEnabled = configStore.get('api_auth_enabled');
    const apiAuthToken = configStore.get('api_auth_token');
    res.json({
      code: 0,
      data: {
        sys: { name },
        api: {
          auth_enabled: apiAuthEnabled === '1',
          auth_token: apiAuthToken || '',
        },
      },
    });
  });

  router.put('/admin/sys-config', (req: Request, res: Response) => {
    const { sys, api } = req.body as {
      sys?: { name?: string };
      api?: { auth_enabled?: boolean; auth_token?: string };
    };
    if (sys && typeof sys.name === 'string' && sys.name.trim()) {
      configStore.set('sys.name', sys.name.trim(), '系统名称');
    }
    if (api) {
      configStore.set(
        'api_auth_enabled',
        api.auth_enabled ? '1' : '0',
        '对外 API 是否启用 X-Api-Key 认证'
      );
      if (typeof api.auth_token === 'string') {
        configStore.set('api_auth_token', api.auth_token, '对外 API 认证 Token');
      }
    }
    log.info({ sys_name: sys?.name, api_auth_enabled: api?.auth_enabled }, 'admin_update_sys_config');
    res.json({ code: 0, message: '保存成功' });
  });

  // ---- 用户管理（仅管理员） ----

  router.get('/admin/users', adminOnlyMiddleware, (_req: Request, res: Response) => {
    const users = usersStore.list().map((u) => ({
      id: u.id,
      user_name: u.username,
      role: u.role,
      note: u.note,
      created_at: u.created_at,
    }));
    res.json({ code: 0, data: users });
  });

  router.post('/admin/users', adminOnlyMiddleware, (req: Request, res: Response) => {
    const { user_name, user_pwd, role, note } = req.body as {
      user_name?: string;
      user_pwd?: string;
      role?: number;
      note?: string;
    };
    if (!user_name || !user_pwd) {
      res.status(400).json({ code: 1001, message: '用户名和密码不能为空' });
      return;
    }

    const strengthErr = validatePasswordStrength(user_pwd);
    if (strengthErr) {
      res.status(400).json({ code: 1001, message: strengthErr });
      return;
    }

    if (usersStore.get(user_name)) {
      res.status(409).json({ code: 1001, message: '用户名已存在' });
      return;
    }

    const hash = hashPasswordSync(user_pwd);
    const ok = usersStore.create(user_name, hash, role === 1 ? 1 : 0, note || '');
    if (!ok) {
      res.status(500).json({ code: 1001, message: '创建失败' });
      return;
    }

    const cu = getCurrentUser(req);
    log.info({ admin: cu?.uname, target: user_name, role }, 'admin_create_user');
    res.json({ code: 0, message: '添加成功' });
  });

  router.delete('/admin/users/:username', adminOnlyMiddleware, (req: Request, res: Response) => {
    const username = req.params.username;
    if (username === 'admin') {
      res.status(400).json({ code: 1001, message: '不能删除 admin 用户' });
      return;
    }
    const ok = usersStore.remove(username);
    if (!ok) {
      res.status(404).json({ code: 1001, message: '用户不存在' });
      return;
    }
    const cu = getCurrentUser(req);
    log.info({ admin: cu?.uname, target: username }, 'admin_delete_user');
    res.json({ code: 0, message: '已删除' });
  });

  return router;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function extractTitle(requestBody: string | null): string {
  if (!requestBody) return '-';
  try {
    const obj = JSON.parse(requestBody);
    const title =
      (obj.form_data && (obj.form_data.title || obj.form_data.标题)) ||
      obj.title ||
      obj.标题 ||
      '';
    return title || '-';
  } catch {
    return '-';
  }
}

function detectPrimaryIp(): string {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const addr = info.address;
      if (addr.startsWith('172.') || addr.startsWith('10.') || addr.startsWith('192.168.')) {
        candidates.push(addr);
      } else {
        candidates.unshift(addr);
      }
    }
  }
  return candidates[0] || '127.0.0.1';
}