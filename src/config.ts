import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

// ---- 默认值 ----
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');

// 配置文件结构（与 cfg.yml.template 对齐）
interface CfgFile {
  server?: {
    port?: number;
    debug?: boolean;
  };
  sys?: {
    max_concurrent_tasks?: number;
    max_pending_tasks?: number;
    callback_url_token?: string;
    callback_retries?: number;
    callback_retry_interval_sec?: number;
    retention_days?: number;
    model?: string;
    data_dir?: string;
  };
}

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

function envBool(k: string, def: boolean): boolean {
  const v = process.env[k];
  if (v === undefined) return def;
  return v === '1' || v === 'true';
}

/** 从 data/cfg.yml 加载 YAML 配置 */
function loadCfgFile(): CfgFile {
  const paths = [
    join(DATA_DIR, 'cfg.yml'),
    resolve(process.cwd(), 'data', 'cfg.yml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf8');
        return (loadYaml(raw) as CfgFile) ?? {};
      } catch {
        console.warn('config: 解析 cfg.yml 失败，使用默认值');
      }
    }
  }
  return {};
}

const cfg = loadCfgFile();

export function loadConfig(): Config {
  const s = cfg.server ?? {};
  const y = cfg.sys ?? {};
  return {
    server: {
      port: envInt('SERVER_PORT', s.port ?? 20001),
      debug: envBool('DEBUG', s.debug ?? false),
    },
    sys: {
      max_concurrent_tasks: envInt('MAX_CONCURRENT_TASKS', y.max_concurrent_tasks ?? 5),
      max_pending_tasks: envInt('MAX_PENDING_TASKS', y.max_pending_tasks ?? 10),
      callback_url_token: env('CALLBACK_URL_TOKEN', y.callback_url_token ?? ''),
      callback_retries: envInt('CALLBACK_RETRIES', y.callback_retries ?? 3),
      callback_retry_interval_sec: envInt('CALLBACK_RETRY_INTERVAL_SEC', y.callback_retry_interval_sec ?? 2),
      retention_days: envInt('RETENTION_DAYS', y.retention_days ?? 30),
      model: env('MODEL', y.model ?? 'claude-sonnet-4-20250514'),
      data_dir: env('DATA_DIR', y.data_dir ?? DATA_DIR),
    },
  };
}

/** 确保运行时目录存在 */
export function ensureDirs(cfg: Config) {
  mkdirSync(join(cfg.sys.data_dir, 'tasks'), { recursive: true });
  mkdirSync(join(cfg.sys.data_dir, 'logs'), { recursive: true });
}