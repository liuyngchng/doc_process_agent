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

const WORK_CLAUDE_MD = `# doc_process_agent 工作区

你是电子公文处理智能体，运行在这个临时工作目录中。

## 文件下载
- 对方传递的 JSON 中的文件 URL 已开放白名单，无需认证
- 用 curl 下载文件到当前工作目录

## 行为规范
1. 严格按提示词要求的 JSON Schema 输出
2. 最终结果用 \`\`\`json 代码块包裹
3. json 代码块之外不要输出任何其他内容
4. 如果下载失败或文件无法识别，在 JSON 中标记 need_human: true
`;

export interface SdkResult {
  success: boolean;
  rawOutput: string;
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

  // 写入 CLAUDE.md
  await writeFile(join(workDir, 'CLAUDE.md'), WORK_CLAUDE_MD, 'utf8');

  log.info({ taskId }, 'sdk_run_start');

  const start = Date.now();
  let fullOutput = '';

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
    log.info({ taskId, durationMs, outputLen: fullOutput.length }, 'sdk_run_complete');

    return { success: true, rawOutput: fullOutput, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ taskId, durationMs, error: message }, 'sdk_run_error');
    return { success: false, rawOutput: fullOutput, errorMessage: message, durationMs };
  }
}