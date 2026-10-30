/**
 * Claude Code Agent SDK 调用封装
 *
 * 每个任务一个独立工作目录，写入 CLAUDE.md 行为规范，
 * 然后通过 SDK 的 query() 执行。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger.js';
import type { Config } from '../config.js';
import type { StreamEntry } from '../types.js';

const log = getLogger();

/** 根据 LLM 配置构建 Claude Code 子进程环境变量 */
function buildEnv(cfg: Config): Record<string, string | undefined> {
  // SDK 的 env 会整体替换子进程环境（不自动合并 process.env），
  // 因此先继承父进程环境，再用 adapter 配置覆盖。
  const env: Record<string, string | undefined> = { ...process.env };
  const l = cfg.llm;

  // ── 网关地址（必填，config 层已强制校验） ──
  env.ANTHROPIC_BASE_URL = l.base_url;

  // 网关认证
  if (l.auth_token) {
    env.ANTHROPIC_AUTH_TOKEN = l.auth_token;
  } else {
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  // ── 模型映射 ──
  env.ANTHROPIC_MODEL = l.model || env.ANTHROPIC_MODEL;
  if (l.opus_model) env.ANTHROPIC_DEFAULT_OPUS_MODEL = l.opus_model;
  if (l.sonnet_model) env.ANTHROPIC_DEFAULT_SONNET_MODEL = l.sonnet_model;
  if (l.haiku_model) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = l.haiku_model;
  if (l.subagent_model) env.CLAUDE_CODE_SUBAGENT_MODEL = l.subagent_model;
  if (l.effort_level) env.CLAUDE_CODE_EFFORT_LEVEL = l.effort_level;
  if (l.timeout_ms) env.API_TIMEOUT_MS = String(l.timeout_ms);

  // ═══════════════════════════════════════════════════════════════
  // 清理可能让 CLI 绕过网关的凭据
  // ═══════════════════════════════════════════════════════════════
  delete env.ANTHROPIC_API_KEY;

  // ── 文件下载 Token（CLAUDE.md 中通过 $FILE_URL_TOKEN 引用） ──
  if (cfg.sys.file_url_token) {
    env.FILE_URL_TOKEN = cfg.sys.file_url_token;
  } else {
    delete env.FILE_URL_TOKEN;
  }

  // ── 文档审核服务 Token（CLAUDE.md 中通过 $DOC_AUDIT_TOKEN 引用） ──
  if (cfg.doc_audit.token) {
    env.DOC_AUDIT_TOKEN = cfg.doc_audit.token;
  } else {
    delete env.DOC_AUDIT_TOKEN;
  }

  // 私有部署：关闭非必要遥测和归因头
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';

  // 解决 classifier unavailable 的问题（禁用自动模式服务器）
  env.CLAUDE_CODE_AUTO_MODE_SERVER = '0';

  return env;
}

function buildClaudeMd(docUtilUrl: string, renewFileUrlApi: string, docAuditUrl: string, serverPort: number): string {
  const wpsSection = renewFileUrlApi ? `
## 文件下载回退（WPS 接口）

如果通过请求中的 \`file_url\` 直接下载文件失败（超时、403、连接被拒等），
可以尝试通过 WPS 接口用 \`file_id\` 重新获取新的下载链接。

接口令牌通过环境变量 \`FILE_URL_TOKEN\` 提供，**不要在日志或屏幕上输出此 Token**。

\`\`\`bash
curl -s -k --noproxy '*' -X POST '${renewFileUrlApi}' \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer $FILE_URL_TOKEN" \\
  -d '{"fileId": "<文件ID>", "getFileUrlType": "download"}' | jq -r '.data'
\`\`\`

步骤：
1. 从请求 JSON 的 \`files[].file_id\` 字段获取文件 ID
2. 用上述命令获取新下载 URL（\`jq -r '.data'\` 返回的就是 file_url）
3. 用新的 URL 重新 curl 下载文件
4. 如果仍然失败，标记 \`need_human: true\` 并在 \`fail_reason\` 中说明原因
` : '';

  const docAuditSection = docAuditUrl ? `
## 文档审核服务（rdCLI 审稿）

同网络下有一个文档审核服务，可对 .docx 文档进行体例格式校对（错别字、标点、语法、逻辑、GB/T 9704-2012 党政公文规范等）。服务为异步模式，**提交后通过轮询获取结果**。

接口令牌通过环境变量 \`DOC_AUDIT_TOKEN\` 提供，**不要在日志或屏幕上输出此 Token**。

### 提交审稿任务

\`\`\`bash
curl -s -k --noproxy '*' -X POST '${docAuditUrl}' \\
  -H "x-api-key: $DOC_AUDIT_TOKEN" \\
  -F "file=@正文.docx" \\
  -F "callback_url=http://localhost:${serverPort}/api/dev/null" \\
  -F "additional_instructions=请严格按 GB/T 9704-2012 党政机关公文格式标准进行校对"
\`\`\`

返回 JSON:
- \`task_id\`: 审稿任务 ID
- \`data.status\`: 初始为 \`"pending"\`

### 轮询获取结果

\`\`\`bash
curl -s -k --noproxy '*' -X GET '${docAuditUrl}/task?id=<审稿task_id>' \\
  -H "x-api-key: $DOC_AUDIT_TOKEN" | jq '.'
\`\`\`

当 \`data.status\` 为 \`"completed"\` 时，\`data.result_text\` 即为 Markdown 格式的核稿意见。
如果 \`data.status\` 仍为 \`"pending"\` 或 \`"processing"\`，等待 15 秒后重新轮询，最多等待 5 分钟。

返回 JSON（已完成后）:
- \`code\`: 0 成功，2001 失败，2002 已撤销
- \`data.status\`: \`"completed"\` | \`"failed"\` | \`"cancelled"\`
- \`data.result_text\`: 核稿意见全文（Markdown），仅 completed 时有
- \`data.file_name\`: 文件名
- \`data.tokens\`: Token 消耗统计
` : '';

  return `# doc_process_agent 工作区

你是电子公文处理智能体，运行在这个临时工作目录中。

## 文件下载
- 对方传递的 JSON 中的文件 URL 已开放白名单，无需认证
- 如果文件 URL 需要认证，可用环境变量 \`FILE_URL_TOKEN\`（Bearer Token）下载：
  \`curl -s -k --noproxy '*' -H "Authorization: Bearer $FILE_URL_TOKEN" '<file_url>' -o 文件名\`
- 用 curl 下载文件到当前工作目录
${wpsSection}
## 文档解析服务

同网络下有一个文档解析服务，可将 PDF / DOCX / .doc（旧版 Word）转为纯文本，
同时自动检测印章。文字版和扫描版 PDF 均支持。

\`\`\`bash
curl -s -k --noproxy '*' -X POST ${docUtilUrl}/extract/txt \\
  -F "file=@文件名" | jq '.'
\`\`\`

返回 JSON:
- \`text\`: 提取的全部文本
- \`has_seal\`: 是否检测到印章 (true/false)
- \`seal_text\`: 印章文字列表，如 ["北京XX科技有限公司", "财务专用章"]
- \`ocr_confidence\`: OCR 置信度 0.0–1.0 (1.0=纯文字提取，无需 OCR)

示例:
\`\`\`bash
curl -s -k --noproxy '*' -X POST ${docUtilUrl}/extract/txt \\
  -F "file=@document.pdf" | jq -r '.text'
\`\`\`

注意事项:
- 该服务使用自签名 HTTPS 证书，务必带 \`-k\` 跳过证书校验
- 用 \`--noproxy '*'\` 绕过代理直连
- 对下载的每个文件都调用此服务提取文本
- 文件大小上限 64MB
${docAuditSection}
## 行为规范
1. 所有文本内容（fail_reason、opinion_text、desc 等）必须使用简体中文
2. 严格按提示词要求的 JSON Schema 输出
3. 最终结果用 \`\`\`json 代码块包裹
4. json 代码块之外不要输出任何其他内容
5. 如果下载失败或文件无法识别，在 JSON 中标记 need_human: true
`;
}

export interface SdkResult {
  success: boolean;
  rawOutput: string;
  trace: string;
  errorMessage?: string;
  durationMs: number;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

/** 需要过滤掉的 SDK 内部系统消息（度量/调试类，对用户无意义）*/
const NOISE_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'stream_event',
  'token_count',
  'model_usage',
]);

/** 把单条 SDK 消息拆解成人类可读的 StreamEntry 数组 */
function parseMessage(msg: Record<string, unknown>): StreamEntry[] {
  const entries: StreamEntry[] = [];
  const now = ts();

  if (msg.type === 'assistant') {
    const message = msg.message as Record<string, unknown> | undefined;
    const blocks = (message?.content as Array<Record<string, unknown>>) ?? [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        entries.push({ ts: now, type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? 'unknown');
        const input = JSON.stringify(block.input ?? {});
        entries.push({
          ts: now,
          type: 'tool',
          text: `调用工具: ${name}`,
          tool_name: name,
          tool_input: input,
        });
      }
      // thinking / redacted_thinking 等内部推理 block 直接忽略，不展示
    }
  } else if (msg.type === 'user') {
    // user 消息可能包含 tool_result
    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result') {
          const isError = !!block.is_error;
          let output = '';
          if (Array.isArray(block.content)) {
            output = (block.content as Array<{ type?: string; text?: string }>)
              .filter(c => c.type === 'text' && typeof c.text === 'string')
              .map(c => c.text!).join('\n');
          } else if (typeof block.content === 'string') {
            output = block.content;
          }
          // 截断过长输出
          if (output.length > 200) output = output.slice(0, 200) + '...';
          entries.push({
            ts: now,
            type: isError ? 'error' : 'tool_result',
            text: isError ? `工具执行出错: ${output}` : output || '(空)',
            tool_output: output,
          });
        }
      }
    }
  } else if (msg.type === 'system') {
    const subtype = String(msg.subtype ?? '');
    // 过滤内部度量消息（thinking_tokens 等），只保留有意义的系统消息
    if (subtype && !NOISE_SYSTEM_SUBTYPES.has(subtype)) {
      entries.push({ ts: now, type: 'system', text: subtype });
    }
  }

  return entries;
}

export async function runAgent(
  taskId: string,
  renderedPrompt: string,
  cfg: Config,
  onStreamEntry?: (entries: StreamEntry[]) => void,
): Promise<SdkResult> {
  const workDir = join(cfg.sys.data_dir, 'tasks', taskId);
  await mkdir(workDir, { recursive: true });

  // 写入 CLAUDE.md（含 doc_util 解析服务地址 + 文件 URL 续期回退说明 + rdCLI 审稿服务说明）
  await writeFile(
    join(workDir, 'CLAUDE.md'),
    buildClaudeMd(cfg.sys.doc_util_url, cfg.sys.renew_file_url_api, cfg.doc_audit.api_url, cfg.server.port),
    'utf8',
  );

  log.info({ taskId }, 'sdk_run_start');

  const start = Date.now();
  let fullOutput = '';
  const traceMessages: unknown[] = [];

  try {
    const q = query({
      prompt: renderedPrompt,
      options: {
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        tools: { type: 'preset', preset: 'claude_code' },
        model: cfg.llm.model || cfg.sys.model,
        env: buildEnv(cfg),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    });

    for await (const message of q) {
      traceMessages.push(message);

      // 实时回调：把 SDK 消息拆成可读条目
      if (onStreamEntry) {
        const entries = parseMessage(message);
        if (entries.length > 0) onStreamEntry(entries);
      }

      if (message.type === 'assistant') {
        const blocks = message.message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string') {
              fullOutput += block.text;
            }
          }
        }
      }
    }

    const durationMs = Date.now() - start;
    const trace = JSON.stringify(traceMessages);
    log.info({ taskId, durationMs, outputLen: fullOutput.length, traceLen: trace.length }, 'sdk_run_complete');

    return { success: true, rawOutput: fullOutput, trace, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const trace = JSON.stringify(traceMessages);
    log.error({ taskId, durationMs, error: message, partialTraceLen: trace.length }, 'sdk_run_error');
    return { success: false, rawOutput: fullOutput, trace, errorMessage: message, durationMs };
  }
}