const Groq = require('groq-sdk');
const OpenAI = require('openai');
const logger = require('./logger');

// ═════════════════════════════════════════════════════════════════════════════
// LLMClient — Provider-agnostic wrapper for vision LLMs (Groq / OpenAI)
// ═════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are an AI browser automation agent. You see an annotated screenshot of a web browser where interactive elements are highlighted with colored bounding boxes and numbered labels.

You must respond with VALID JSON ONLY — no markdown, no extra text, no code fences.

Response format:
{
  "action": "action_name",
  "elementId": null,
  "params": {},
  "reasoning": "brief explanation"
}

Available actions:
- click: Click on a numbered element. { "action": "click", "elementId": 3, "params": {}, "reasoning": "..." }
- type: Type text into the currently focused field. { "action": "type", "elementId": null, "params": { "text": "Hello" }, "reasoning": "..." }
  ALWAYS click on an input field first, then type in the next step.
- scroll: Scroll the page. { "action": "scroll", "elementId": null, "params": { "direction": "down", "amount": 400 }, "reasoning": "..." }
- navigate: Go to a URL. { "action": "navigate", "elementId": null, "params": { "url": "https://..." }, "reasoning": "..." }
- select_option: Select an option from a dropdown. { "action": "select_option", "elementId": 5, "params": { "value": "option text" }, "reasoning": "..." }
- wait: Wait before next action. { "action": "wait", "elementId": null, "params": { "ms": 1000 }, "reasoning": "..." }
- pause_for_user: Pause and ask the user to do something manually (file uploads, captchas, 2FA, etc).
  { "action": "pause_for_user", "elementId": null, "params": { "message": "Please upload your resume file, then click Resume" }, "reasoning": "..." }
  Use this when you encounter something you CANNOT do yourself (file picker dialogs, authentication, captchas).
- TASK_COMPLETE: Mark task as done. { "action": "TASK_COMPLETE", "elementId": null, "params": {}, "reasoning": "..." }

RULES:
1. ONE action per response — never output multiple actions
2. Refer to elements ONLY by their [number] from the annotated screenshot
3. To fill a field: first use "click" on it (by elementId), then in the NEXT step use "type"
4. Type EXACTLY the text specified in the task — do not paraphrase or modify it
5. Only use TASK_COMPLETE when you can visually CONFIRM the task is done (e.g., fields show correct text)
6. If you don't see the target elements, scroll down to find them
7. If an element you need is not in the elements list, scroll to reveal more of the page
8. NEVER re-fill a field that already has the correct value. Check [value: "..."] in the elements list — if a field already contains the right text, SKIP it and move to the next empty field
9. For file upload fields (type="file") or file attachment buttons: use "pause_for_user" to let the human handle it. Do NOT click file upload buttons repeatedly — you cannot interact with the OS file picker dialog
10. After pausing for the user, when you resume, check the current state of the form and continue from where you left off — do NOT restart from the beginning`;

// Default models per provider
const DEFAULT_MODELS = {
  groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
  openai: 'gpt-4o',
};

class LLMClient {
  constructor() {
    this.provider = process.env.LLM_PROVIDER || 'groq';
    this.model = process.env.LLM_MODEL || DEFAULT_MODELS[this.provider] || DEFAULT_MODELS.groq;

    if (this.provider === 'groq') {
      this.client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else if (this.provider === 'openai') {
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else {
      throw new Error(`Unsupported LLM provider: ${this.provider}. Use 'groq' or 'openai'.`);
    }

    logger.info(`LLM: ${this.provider} / ${this.model}`);
  }

  /**
   * Send annotated screenshot + element list + task to the LLM.
   * Returns parsed action object.
   */
  async decide(annotatedImageBase64, task, conversationHistory, elementListText, extraContext = '') {
    // Build user message with screenshot + context
    let promptText = `TASK: ${task}\n\nELEMENTS ON SCREEN:\n${elementListText}`;
    
    if (extraContext) {
      promptText += `\n\n${extraContext}`;
    }
    
    promptText += `\n\nLook at the annotated screenshot. The numbered labels correspond to the elements listed above. What is your next action? Respond with JSON only.`;

    const userContent = [
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${annotatedImageBase64}` },
      },
      {
        type: 'text',
        text: promptText,
      },
    ];

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: 'user', content: userContent },
    ];

    // Call the API
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 512,
      temperature: 0.1,
      messages,
    });

    const responseText = completion.choices[0].message.content;
    logger.ai(`Raw LLM response: ${responseText}`);

    // Parse the JSON response
    const actionObj = this._parseAction(responseText);
    return { actionObj, responseText };
  }

  /**
   * Send a self-correction prompt after a failed action.
   */
  async retry(annotatedImageBase64, task, conversationHistory, elementListText, failureContext) {
    const userContent = [
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${annotatedImageBase64}` },
      },
      {
        type: 'text',
        text: `TASK: ${task}\n\n⚠️ PREVIOUS ACTION FAILED: ${failureContext}\n\nELEMENTS ON SCREEN:\n${elementListText}\n\nPlease try a different approach. Respond with JSON only.`,
      },
    ];

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory,
      { role: 'user', content: userContent },
    ];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 512,
      temperature: 0.2,
      messages,
    });

    const responseText = completion.choices[0].message.content;
    logger.ai(`Retry LLM response: ${responseText}`);

    const actionObj = this._parseAction(responseText);
    return { actionObj, responseText };
  }

  /**
   * Parse raw text into a structured action object.
   */
  _parseAction(responseText) {
    try {
      let cleaned = responseText.trim();

      // Strip markdown code fences
      cleaned = cleaned.replace(/```(?:json)?\n?([\s\S]*?)```/g, '$1').trim();

      // Extract JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleaned = jsonMatch[0];

      const parsed = JSON.parse(cleaned);

      if (!parsed.action) {
        throw new Error('Missing "action" field');
      }

      return {
        action: parsed.action,
        elementId: parsed.elementId ?? null,
        params: parsed.params || {},
        reasoning: parsed.reasoning || '',
      };
    } catch (err) {
      logger.error(`Failed to parse LLM response: ${err.message}`);
      return {
        action: 'wait',
        elementId: null,
        params: { ms: 1000 },
        reasoning: 'Failed to parse LLM response — waiting',
      };
    }
  }
}

module.exports = LLMClient;
