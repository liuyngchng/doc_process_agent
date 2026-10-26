import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---- 默认值 ----
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');

export interface Config {
  server: {
    port: number;
    debug: boolean;
  };
  sys: {
    max_concurrent_tasks: number;
    max_pending_tasks: number;
    callback_url_token: string;
    callback_retries: number;
    callback_retry_interval_sec: number;
    retention_days: number;
    model: string;
    data_dir: string;
  };
}

function env(k: string, def: string): string {
  return process.env[k] ?? def;
}

function envInt(k: string, def: number): number {
  const v = parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

// 尝试从 data/cfg.yml 加载配置（简化版：解析顶层 key）
function loadCfgYml(): Record<string, string> {
  try {
    const raw = readFileSync(join(DATA_DIR, 'cfg.yml'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf(':');
      if (idx < 0) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
      if (k && v) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

const cfg = loadCfgYml();

export function loadConfig(): Config {
  return {
    server: {
      port: envInt('SERVER_PORT', parseInt(cfg.server_port ?? '20001', 10)),
      debug: env('DEBUG', cfg.debug ?? 'false') === 'true',
    },
    sys: {
      max_concurrent_tasks: envInt('MAX_CONCURRENT_TASKS', parseInt(cfg.max_concurrent_tasks ?? '5', 10)),
      max_pending_tasks: envInt('MAX_PENDING_TASKS', parseInt(cfg.max_pending_tasks ?? '10', 10)),
      callback_url_token: env('CALLBACK_URL_TOKEN', cfg.callback_url_token ?? ''),
      callback_retries: envInt('CALLBACK_RETRIES', parseInt(cfg.callback_retries ?? '3', 10)),
      callback_retry_interval_sec: envInt('CALLBACK_RETRY_INTERVAL_SEC', parseInt(cfg.callback_retry_interval_sec ?? '2', 10)),
      retention_days: envInt('RETENTION_DAYS', parseInt(cfg.retention_days ?? '30', 10)),
      model: env('MODEL', cfg.model ?? 'claude-sonnet-4-20250514'),
      data_dir: DATA_DIR,
    },
  };
}

// 确保运行时目录存在
export function ensureDirs(cfg: Config) {
  mkdirSync(join(cfg.sys.data_dir, 'tasks'), { recursive: true });
  mkdirSync(join(cfg.sys.data_dir, 'logs'), { recursive: true });
}