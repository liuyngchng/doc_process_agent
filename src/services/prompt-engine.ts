/**
 * 提示词渲染引擎
 *
 * 支持 {{request.body}} {{request.linkid}} {{request.xxx.yyy}} 等多层级占位符。
 * 实现：正则匹配 → JSONPath 解析 → JSON.stringify 替换。
 */

// 从对象中按点号路径取值
function deepGet(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * 渲染提示词，替换 {{placeholder}}。
 *
 * 支持的占位符：
 *   {{request.body}}      → 整个请求 JSON
 *   {{request.xxx}}       → 请求 JSON 中的 xxx 字段
 *   {{request.xxx.yyy}}   → 嵌套字段
 */
export function renderPrompt(template: string, requestBody: Record<string, unknown>): string {
  return template.replace(
    /\{\{(request\.[^}]+)\}\}/g,
    (_match: string, path: string) => {
      const fieldPath = path.replace(/^request\./, '');
      let value: unknown;
      if (fieldPath === 'body') {
        value = requestBody;
      } else {
        value = deepGet(requestBody, fieldPath);
      }
      if (value === undefined || value === null) {
        return ''; // 找不到的字段用空字符串替换
      }
      if (typeof value === 'string') {
        return value;
      }
      return JSON.stringify(value, null, 2);
    }
  );
}