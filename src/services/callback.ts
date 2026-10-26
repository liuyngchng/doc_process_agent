/**
 * 回调投递 + 重试
 *
 * 向 callback_url 发起 POST，失败自动重试（默认 3 次，指数退避）。
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { getLogger } from '../logger.js';
import type { Config } from '../config.js';
import type { ApiResponse } from '../types.js';

const log = getLogger();

export interface CallbackResult {
  success: boolean;
  body: string;
  retryCount: number;
  errorMsg?: string;
}

/**
 * 发送单次回调 POST。成功返回 true，否则返回 false。
 */
function postOnce(url: string, payload: string, token?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
    };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    const port = parsed.port || (isHttps ? 443 : 80);

    const req = transport.request({
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    }, (res) => {
      res.resume();
      const ok = res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300;
      log.info({ url, statusCode: res.statusCode, ok }, 'callback_response');
      resolve(ok);
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error('callback_timeout'));
    });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

/**
 * 投递回调，重试最多 N 次。
 */
export async function deliverCallback(
  callbackUrl: string,
  payload: ApiResponse,
  cfg: Config,
): Promise<CallbackResult> {
  const maxRetries = cfg.sys.callback_retries;
  const baseInterval = cfg.sys.callback_retry_interval_sec * 1000;
  const token = cfg.sys.callback_url_token || undefined;
  const bodyStr = JSON.stringify(payload);

  log.info({ taskId: payload.task_id, url: callbackUrl }, 'callback_start');

  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      retryCount = attempt;
      const delay = baseInterval * Math.pow(2, attempt - 1);
      log.warn({ taskId: payload.task_id, attempt, delayMs: delay }, 'callback_retry');
      await new Promise((r) => setTimeout(r, delay));
    }

    const ok = await postOnce(callbackUrl, bodyStr, token);
    if (ok) {
      log.info({ taskId: payload.task_id, retries: retryCount }, 'callback_success');
      return { success: true, body: bodyStr, retryCount };
    }
  }

  const errMsg = '回调失败，已重试 ' + maxRetries + ' 次';
  log.error({ taskId: payload.task_id, retries: maxRetries }, 'callback_all_retries_failed');
  return { success: false, body: bodyStr, retryCount: maxRetries, errorMsg: errMsg };
}
