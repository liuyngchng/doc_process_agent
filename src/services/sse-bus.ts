/**
 * 轻量 SSE 事件总线 —— 连接 SDK 流式消息与前端 EventSource
 *
 * sdk-runner 每收到一条消息就 publish，admin.ts 的 SSE 路由 subscribe 消费。
 */
import type { Response } from 'express';

type Subscriber = (message: unknown) => void;

const channels = new Map<string, Set<Subscriber>>();

export function subscribe(sessionId: string, sub: Subscriber): void {
  let set = channels.get(sessionId);
  if (!set) {
    set = new Set();
    channels.set(sessionId, set);
  }
  set.add(sub);
}

export function unsubscribe(sessionId: string, sub: Subscriber): void {
  channels.get(sessionId)?.delete(sub);
}

export function publish(sessionId: string, message: unknown): void {
  const set = channels.get(sessionId);
  if (!set) return;
  for (const sub of set) {
    try { sub(message); } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/** 向单个 SSE 连接推送 SessionMessage（JSON-lines 格式） */
export function sendSSE(res: Response, message: unknown): void {
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}