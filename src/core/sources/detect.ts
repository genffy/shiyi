import type { SourceId } from '../types.js';

export type DetectedKind =
  | 'chatgpt-zip'
  | 'chatgpt-json'
  | 'chatgpt-codex-json'
  | 'gemini-takeout-zip'
  | 'gemini-takeout-json'
  | 'role-chat-json'
  | 'grok-markdown';

export interface Detection {
  kind: DetectedKind;
  /** source inference for role-chat-json (kimi/grok) */
  roleSource?: SourceId;
}

/** Classify which cloud export a JSON text belongs to (for loose JSON files and zip entries) */
export function classifyJson(text: string, pathHint = ''): Detection {
  const head = text.slice(0, 4096);
  const sample = text.slice(0, 65536);

  // ChatGPT conversations.json: array elements carry mapping/conversation_id
  if (head.includes('"mapping"') && (head.includes('"conversation_id"') || head.includes('"current_node"'))) {
    return { kind: 'chatgpt-json' };
  }
  if (pathHint.toLowerCase().includes('conversations.json')) {
    return { kind: 'chatgpt-json' };
  }

  // codex.json inside a ChatGPT export (cloud Codex tasks)
  if (/"turns"\s*:/.test(sample) && (/"input_items"\s*:/.test(sample) || /"output_items"\s*:/.test(sample))) {
    return { kind: 'chatgpt-codex-json' };
  }
  if (/codex\.json$/i.test(pathHint)) {
    return { kind: 'chatgpt-codex-json' };
  }

  // Gemini Takeout MyActivity: path hint takes priority
  if (/myactivity\.json$/i.test(pathHint) || pathHint.toLowerCase().includes('gemini')) {
    return { kind: 'gemini-takeout-json' };
  }

  // Score field signatures over the first 64KB: sender+message -> grok; entries+role -> gemini-web; chat_id -> kimi; conversationId -> grok
  let grok = 0;
  let kimi = 0;
  let gemini = 0;
  if (/"sender"\s*:/.test(sample) && /"message"\s*:/.test(sample)) grok += 2;
  if (/"conversationId"\s*:/.test(sample) || /"conversation_id"\s*:/.test(sample)) grok += 1;
  if (/"chat_id"\s*:/.test(sample)) kimi += 2;
  if (/"kimi"/i.test(sample)) kimi += 1;
  if (/"entries"\s*:/.test(sample) && /"role"\s*:/.test(sample)) gemini += 2;
  if (/"create_time"\s*:/.test(sample) && !/"createTime"/.test(sample)) kimi += 1;

  if (gemini > grok && gemini > kimi) return { kind: 'gemini-takeout-json' };
  if (grok > kimi) return { kind: 'role-chat-json', roleSource: 'grok' };
  if (kimi > grok) return { kind: 'role-chat-json', roleSource: 'kimi' };
  return { kind: 'role-chat-json', roleSource: 'grok' };
}
