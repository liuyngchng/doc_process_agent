/**
 * 回调投递 + 重试
 *
 * 向 callback_url 发起 POST，失败自动重试（默认 3 次，指数退避）。
 * request/curl/响应体使用 debug 级别，HTTP 状态码使用 info 级别（方便排查）。
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { getLogger } from '../logger.js';
import type { Config } from '../config.js';
import type { ApiResponse, StreamEntry } from '../types.js';

const log = getLogger();

/** 生成 HH:MM:ss.SSS 时间戳 */
function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

export interface CallbackResult {
  success: boolean;
  body: string;
  responseBody: string;
  lastStatusCode: number | undefined;
  retryCount: number;
  errorMsg?: string;
}

interface PostResult {
  ok: boolean;
  statusCode: number | undefined;
  responseBody: string;
}

/**
 * 发送单次回调 POST。
 */
function postOnce(url: string, payload: string, token?: string): Promise<PostResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, statusCode: undefined, responseBody: '' });
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
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        const ok = res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300;
        log.debug(
          { url, statusCode: res.statusCode, ok, response_body: responseBody },
          'callback_response',
        );
        resolve({ ok, statusCode: res.statusCode, responseBody });
      });
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error('callback_timeout'));
    });
    req.on('error', (err) => {
      log.debug({ url, error: err.message }, 'callback_request_error');
      resolve({ ok: false, statusCode: undefined, responseBody: '' });
    });
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
  onStream?: (entries: StreamEntry[]) => void,
): Promise<CallbackResult> {
  const maxRetries = cfg.sys.callback_retries;
  const baseInterval = cfg.sys.callback_retry_interval_sec * 1000;
  const token = cfg.sys.file_url_token || undefined;
  const bodyStr = JSON.stringify(payload);

  // 生成 curl，输出到流式 + info 日志（方便排查）
  const bodyEsc = bodyStr.replace(/'/g, "'\\''");
  const authHeader = token ? `-H 'Authorization: Bearer ${token}'` : "-H 'Authorization: Bearer sk-***'";
  const curlCmd = `curl -k --noproxy '*' -H 'Content-Type: application/json' ${authHeader} -d '${bodyEsc}' ${callbackUrl}`;

  onStream?.([{ ts: ts(), type: 'system', text: `开始回调 POST ${callbackUrl}`, tool_name: 'callback', tool_input: curlCmd }]);

  // 打印 request（包含 curl）和完整 payload
  log.info({ taskId: payload.task_id, url: callbackUrl, curl: curlCmd }, 'callback_request');
  log.debug({ taskId: payload.task_id, url: callbackUrl, payload }, 'callback_request_payload');

  let retryCount = 0;
  let lastResponseBody = '';
  let lastStatusCode: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      retryCount = attempt;
      const delay = baseInterval * Math.pow(2, attempt - 1);
      onStream?.([{ ts: ts(), type: 'system', text: `回调重试 #${attempt}，${delay}ms 后重试` }]);
      // 重试时打印上次 HTTP 状态码
      log.warn(
        { taskId: payload.task_id, attempt, delayMs: delay, lastStatusCode, lastResponseBody: lastResponseBody.slice(0, 500) },
        'callback_retry',
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    const result = await postOnce(callbackUrl, bodyStr, token);
    lastResponseBody = result.responseBody;
    lastStatusCode = result.statusCode;
    if (result.ok) {
      onStream?.([{
        ts: ts(),
        type: 'tool_result',
        text: `回调成功 (HTTP ${result.statusCode})`,
        tool_output: lastResponseBody,
      }]);
      log.info(
        { taskId: payload.task_id, retries: retryCount, statusCode: result.statusCode },
        'callback_success',
      );
      return { success: true, body: bodyStr, responseBody: result.responseBody, lastStatusCode: result.statusCode, retryCount };
    }
  }

  const errMsg = '回调失败，已重试 ' + maxRetries + ' 次';
  onStream?.([{
    ts: ts(),
    type: 'error',
    text: `回调失败 (HTTP ${lastStatusCode ?? 'unknown'})，已重试 ${maxRetries} 次`,
    tool_output: lastResponseBody,
  }]);
  log.error(
    { taskId: payload.task_id, retries: maxRetries, lastStatusCode, last_response_body: lastResponseBody },
    'callback_all_retries_failed',
  );
  return { success: false, body: bodyStr, responseBody: lastResponseBody, lastStatusCode, retryCount: maxRetries, errorMsg: errMsg };
}