// 議事録の作成 Workflow（docs/minutes-design.md §5、cloudflare-small-design.md §7）。
// 本体は minutes/pipeline.js。ここは Workflows のクラスに包み、core と settings を渡すだけ。
import { WorkflowEntrypoint } from 'cloudflare:workers';
import {
  renderPrompt,
  offsetTimestamps,
  joinSegments,
  estimateCost,
  usageEvent,
  buildGenerateRequest,
  parseGenerateResponse,
  buildFilesUploadRequest,
  buildFilesUploadBodyHeaders,
  buildFileGetRequest,
  buildFileDeleteRequest,
  classifyGeminiError,
  buildTranscriptionRequest,
  parseTranscriptionResponse,
  buildChatRequest,
  parseChatResponse,
  classifyOpenAIError,
} from '@hyper-sfa/core';
import { getApiKey, getSelectedModel, getModel, getPrompt } from '../lib/settings.js';
import { recordUsage } from '../lib/usage.js';
import { runMinutesPipeline } from '../minutes/pipeline.js';

const deps = {
  renderPrompt,
  offsetTimestamps,
  joinSegments,
  estimateCost,
  usageEvent,
  buildGenerateRequest,
  parseGenerateResponse,
  buildFilesUploadRequest,
  buildFilesUploadBodyHeaders,
  buildFileGetRequest,
  buildFileDeleteRequest,
  classifyGeminiError,
  buildTranscriptionRequest,
  parseTranscriptionResponse,
  buildChatRequest,
  parseChatResponse,
  classifyOpenAIError,
  getApiKey,
  getSelectedModel,
  getModel,
  getPrompt,
  recordUsage,
};

export class MinutesWorkflow extends WorkflowEntrypoint {
  // event.payload = { minuteId, target: 'generate' | 'summary' | 'transcript' }
  // または { test: true, jobId, kind, audioKey, transcript, promptText, modelId, userId }（開発コンソールの試し）
  async run(event, step) {
    return await runMinutesPipeline({ env: this.env, deps, event, step });
  }
}
