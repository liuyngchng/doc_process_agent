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

  // 私有部署：关闭非必要遥测和归因头
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';

  return env;
}

function buildClaudeMd(docUtilUrl: string, renewFileUrlApi: string): string {
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

## 行为规范
1. 严格按提示词要求的 JSON Schema 输出
2. 最终结果用 \`\`\`json 代码块包裹
3. json 代码块之外不要输出任何其他内容
4. 如果下载失败或文件无法识别，在 JSON 中标记 need_human: true
`;
}

export interface SdkResult {
  success: boolean;
  rawOutput: string;
  trace: string;
  errorMessage?: string;
  durationMs: number;
}

export async function runAgent(
  taskId: string,
  renderedPrompt: string,
  cfg: Config,
): Promise<SdkResult> {
  const workDir = join(cfg.sys.data_dir, 'tasks', taskId);
  await mkdir(workDir, { recursive: true });

  // 写入 CLAUDE.md（含 doc_util 解析服务地址 + 文件 URL 续期回退说明）
  await writeFile(
    join(workDir, 'CLAUDE.md'),
    buildClaudeMd(cfg.sys.doc_util_url, cfg.sys.renew_file_url_api),
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
      log.debug({ taskId, msg: message }, 'sdk_stream_msg');
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