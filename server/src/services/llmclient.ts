import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getSettings } from './settings.js';

// Undated alias — Anthropic keeps this pointed at the newest Sonnet snapshot,
// so this file never needs a manual bump when a new Claude model ships.
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';

const SYSTEM_PROMPT = `You generate a single, self-contained, standalone HTML file that previews the content of an Obsidian-style markdown note for a human to skim quickly.

Rules:
- Output ONLY raw HTML. No markdown code fences, no explanation before or after.
- The file must be fully self-contained: inline all CSS and JavaScript. Do not reference external stylesheets, scripts, or fonts that require network access.
- Plain <a href="..."> links (e.g. to Google Maps, external sites) are fine and encouraged when the user's instructions call for them.
- Make the layout clean, readable, and easy to skim at a glance.
- Base the content strictly on the note's markdown content given below, following the user's instructions for how to present it.`;

/** Strip a ```html ... ``` (or bare ``` ... ```) fence if the model wrapped its output in one. */
function extractHtml(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

async function generateAnthropic(apiKey: string, userContent: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });
  return msg.content.map((b) => ('text' in b ? b.text : '')).join('\n');
}

async function generateOpenAI(apiKey: string, model: string, userContent: string): Promise<string> {
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: model || 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });
  return completion.choices[0]?.message?.content ?? '';
}

export async function generateHtml(noteContent: string, prompt: string): Promise<string> {
  const s = await getSettings();
  const userContent = `${prompt}\n\n--- Note content (Markdown) ---\n${noteContent}`;

  let text: string;
  if (s.llm.provider === 'anthropic') {
    if (!s.llm.anthropicApiKey) {
      throw Object.assign(new Error('Chưa cấu hình Anthropic API key. Vào Settings → AI để thêm.'), { status: 400 });
    }
    text = await generateAnthropic(s.llm.anthropicApiKey, userContent);
  } else {
    if (!s.llm.openaiApiKey) {
      throw Object.assign(new Error('Chưa cấu hình OpenAI API key. Vào Settings → AI để thêm.'), { status: 400 });
    }
    text = await generateOpenAI(s.llm.openaiApiKey, s.llm.openaiModel, userContent);
  }

  if (!text.trim()) {
    throw Object.assign(new Error('LLM trả về nội dung rỗng, thử lại.'), { status: 502 });
  }
  return extractHtml(text);
}
