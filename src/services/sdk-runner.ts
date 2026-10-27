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

function buildClaudeMd(docUtilUrl: string): string {
  return `# doc_process_agent 工作区

你是电子公文处理智能体，运行在这个临时工作目录中。

## 文件下载
- 对方传递的 JSON 中的文件 URL 已开放白名单，无需认证
- 用 curl 下载文件到当前工作目录

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

  // 写入 CLAUDE.md（含 doc_util 解析服务地址）
  await writeFile(join(workDir, 'CLAUDE.md'), buildClaudeMd(cfg.sys.doc_util_url), 'utf8');

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
        model: cfg.sys.model,
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