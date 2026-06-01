const fs = require('fs');
const Browser = require('./browser');
const LLMClient = require('./llm');
const { annotate, buildElementListText } = require('./annotator');
const logger = require('./logger');
require('dotenv').config();

// ═════════════════════════════════════════════════════════════════════════════
// Agent — Vision-based automation loop with self-correction & loop detection
//
// Loop: Screenshot → Annotate → LLM Decision → Execute → Verify → Repeat
// ═════════════════════════════════════════════════════════════════════════════

const MAX_RETRIES_PER_ACTION = 2;
const MAX_REPEAT_ACTIONS = 3;  // Break loop if same action repeats this many times

class Agent {
  constructor(emitter = null) {
    this.browser = new Browser();
    this.llm = new LLMClient();
    this.emitter = emitter;
    this.running = false;
    this.conversationHistory = [];
    this.actionHistory = [];       // Track recent actions for loop detection
    this.lastClickedElement = null; // Track last clicked element for type hints
    this._resumeResolve = null;    // Resolve function for pause_for_user
  }

  /** Emit an event to the dashboard (if connected) */
  _emit(event, data) {
    if (this.emitter) {
      try { this.emitter.emit(event, data); } catch (e) { /* ignore */ }
    }
  }

  /** Stop the agent gracefully */
  stop() {
    this.running = false;
    logger.info('Agent stop requested');
    // If paused, also unblock
    if (this._resumeResolve) {
      this._resumeResolve();
      this._resumeResolve = null;
    }
  }

  /** Resume the agent after a pause_for_user action */
  resume() {
    if (this._resumeResolve) {
      logger.info('▶ Agent resumed by user');
      this._resumeResolve();
      this._resumeResolve = null;
    }
  }

  /**
   * Detect if the agent is stuck in a loop (same action repeated 3+ times).
   * Returns a hint string if stuck, or null if not.
   */
  _detectLoop(actionObj) {
    const key = `${actionObj.action}:${actionObj.elementId}:${JSON.stringify(actionObj.params)}`;
    this.actionHistory.push(key);

    // Keep only last 5 actions
    if (this.actionHistory.length > 5) {
      this.actionHistory.shift();
    }

    // Check if the last N actions are identical
    if (this.actionHistory.length >= MAX_REPEAT_ACTIONS) {
      const lastN = this.actionHistory.slice(-MAX_REPEAT_ACTIONS);
      const allSame = lastN.every(a => a === lastN[0]);
      if (allSame) {
        return `You have repeated the same action (${actionObj.action} on element [${actionObj.elementId}]) ${MAX_REPEAT_ACTIONS} times. This is not working. Try a DIFFERENT approach — for example, if you keep clicking a field, try typing instead. If clicking doesn't focus the field, try scrolling to it first or clicking a different element.`;
      }
    }

    return null;
  }

  /**
   * Run the agent with the given task.
   * @param {string} task - Natural language task description
   * @returns {{ success: boolean, steps: number }}
   */
  async run(task) {
    this.running = true;
    let stepCount = 0;
    const MAX_STEPS = parseInt(process.env.MAX_STEPS) || 20;

    try {
      logger.info('🚀 Agent starting...');
      this._emit('status', { state: 'running' });

      // Validate API key
      const provider = process.env.LLM_PROVIDER || 'groq';
      const key = provider === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
      if (!key || key.includes('your_') || key.includes('_here')) {
        throw new Error(`API key not configured for ${provider}. Check your .env file.`);
      }

      // Launch browser
      await this.browser.launch();

      // ── Agent Loop ──────────────────────────────────────────────────────
      for (let step = 0; step < MAX_STEPS && this.running; step++) {
        stepCount++;
        logger.info(`\n━━━ Step ${stepCount} / ${MAX_STEPS} ━━━`);

        // A. Take clean screenshot
        const screenshotPath = await this.browser.takeScreenshot();
        if (screenshotPath.startsWith && screenshotPath.startsWith('Error')) {
          logger.error(`Screenshot failed: ${screenshotPath}`);
          break;
        }

        // Send clean screenshot to dashboard
        const cleanBase64 = fs.readFileSync(screenshotPath).toString('base64');
        this._emit('screenshot', { base64: cleanBase64 });

        // B. Extract interactive elements
        const elements = await this.browser.getInteractiveElements();
        const elementListText = buildElementListText(elements);

        // C. Annotate the screenshot (inject overlays → screenshot → remove)
        const { annotatedImageBase64 } = await annotate(this.browser.page, elements);
        this._emit('annotated_screenshot', { base64: annotatedImageBase64 });

        // D. Build context hints for the LLM
        let extraContext = '';

        // If we just clicked an input/textarea, hint that it should type next
        if (this.lastClickedElement) {
          const el = this.lastClickedElement;
          extraContext += `\n\nIMPORTANT: You just clicked on element [${el.id}] ("${el.label || el.placeholder || el.tag}") in the previous step. It should now be focused. Your next action should be "type" to enter text into this field. Do NOT click it again.`;
          this.lastClickedElement = null; // Clear after use
        }

        // E. Ask LLM for next action
        let actionObj, responseText;
        try {
          const result = await this.llm.decide(
            annotatedImageBase64, task, this.conversationHistory, elementListText, extraContext
          );
          actionObj = result.actionObj;
          responseText = result.responseText;
        } catch (apiError) {
          logger.error(`LLM API error: ${apiError.message}`);
          this._emit('error', { message: apiError.message });

          // Handle rate limits
          if (apiError.message.includes('tokens per day') || apiError.message.includes('TPD')) {
            const match = apiError.message.match(/try again in (\d+)m/);
            logger.error(`❌ Daily token limit hit. Retry in ~${match?.[1] || '?'} minutes.`);
            break;
          }
          if (apiError.status === 429 || apiError.message.includes('rate')) {
            logger.info('⏳ Rate limited — waiting 10 seconds...');
            await this.browser.wait(10000);
            step--; stepCount--;
            continue;
          }
          break;
        }

        // F. Loop detection — check if we're stuck
        const loopHint = this._detectLoop(actionObj);
        if (loopHint) {
          logger.error(`🔄 Loop detected! Same action repeated ${MAX_REPEAT_ACTIONS}+ times.`);
          this._emit('action', {
            action: 'loop_detected',
            elementId: actionObj.elementId,
            params: {},
            reasoning: loopHint,
            step: stepCount,
            maxSteps: MAX_STEPS,
            timestamp: new Date().toISOString(),
          });

          // Clear the loop history
          this.actionHistory = [];

          // Force a different action: if stuck clicking, try typing
          if (actionObj.action === 'click') {
            // The model keeps clicking — it probably wants to type but can't decide what
            // Let's check if the clicked element is an input
            const targetEl = elements.find(e => e.id === actionObj.elementId);
            if (targetEl && ['input', 'textarea'].includes(targetEl.tag)) {
              // Click it one more time, then ask the LLM specifically what to type
              await this.browser.clickElement(actionObj.elementId, elements);
              
              // Ask LLM with a forced-type prompt
              try {
                const forceResult = await this.llm.retry(
                  annotatedImageBase64, task, this.conversationHistory, elementListText,
                  `You have been clicking element [${actionObj.elementId}] ("${targetEl.label || targetEl.placeholder}") repeatedly without typing anything. The field is now focused. You MUST use the "type" action now to enter text. What text should go in the "${targetEl.label || targetEl.placeholder}" field? Respond with a type action.`
                );
                actionObj = forceResult.actionObj;
                responseText = forceResult.responseText;
              } catch (err) {
                logger.error(`Force-type prompt failed: ${err.message}`);
              }
            } else {
              // Not an input — try scrolling to escape
              actionObj = { action: 'scroll', elementId: null, params: { direction: 'down', amount: 300 }, reasoning: 'Breaking out of click loop by scrolling' };
              responseText = JSON.stringify(actionObj);
            }
          }
        }

        // G. Update conversation history with rich context (keep last 8 messages)
        const userMsg = `[Step ${stepCount}] Annotated screenshot with ${elements.length} elements. ${extraContext}`;
        this.conversationHistory.push(
          { role: 'user', content: userMsg },
          { role: 'assistant', content: responseText }
        );
        if (this.conversationHistory.length > 8) {
          this.conversationHistory.splice(0, this.conversationHistory.length - 8);
        }

        // H. Log and emit the action
        logger.action(`Action: ${actionObj.action} | Element: ${actionObj.elementId ?? 'none'} | Params: ${JSON.stringify(actionObj.params)}`);
        logger.info(`💭 Reasoning: ${actionObj.reasoning}`);
        this._emit('action', {
          ...actionObj,
          step: stepCount,
          maxSteps: MAX_STEPS,
          timestamp: new Date().toISOString(),
        });

        // I. Check for completion
        if (actionObj.action === 'TASK_COMPLETE') {
          logger.success('✅ TASK COMPLETE!');
          logger.success(`Reasoning: ${actionObj.reasoning}`);
          this._emit('task_complete', { steps: stepCount, reasoning: actionObj.reasoning });
          this._emit('status', { state: 'complete' });
          break;
        }

        // I2. Handle pause_for_user (file uploads, captchas, etc.)
        if (actionObj.action === 'pause_for_user') {
          const pauseMsg = actionObj.params?.message || 'The agent needs your help with something it cannot do automatically.';
          logger.info(`⏸ Pausing for user: ${pauseMsg}`);
          this._emit('status', { state: 'paused' });
          this._emit('pause_for_user', {
            message: pauseMsg,
            reasoning: actionObj.reasoning,
            step: stepCount,
            timestamp: new Date().toISOString(),
          });

          // Wait until the user clicks Resume in the dashboard
          await new Promise((resolve) => {
            this._resumeResolve = resolve;
          });

          if (!this.running) break; // User might have stopped instead of resuming

          logger.info('▶ Resumed — continuing from current state');
          this._emit('status', { state: 'running' });
          // Don't count this pause as a step, re-do this iteration
          step--;
          stepCount--;
          continue;
        }

        // J. Execute the action
        const result = await this._executeAction(actionObj, elements);
        logger.info(`Result: ${result}`);

        // K. Track clicked input elements for type hints
        if (actionObj.action === 'click' && actionObj.elementId) {
          const clickedEl = elements.find(e => e.id === actionObj.elementId);
          if (clickedEl && ['input', 'textarea', 'select'].includes(clickedEl.tag)) {
            this.lastClickedElement = clickedEl;
          }
        }

        // L. Self-correction: verify the action worked
        if (actionObj.action === 'type') {
          await this._verifySelfCorrect(actionObj, elements, task, elementListText, step);
        }

        // M. Brief delay between steps
        await this.browser.wait(300);
      }

      // ── Cleanup ─────────────────────────────────────────────────────────
      await this.browser.close();
      this.running = false;
      logger.info(`🏁 Agent finished after ${stepCount} steps`);
      if (this.emitter) this._emit('status', { state: 'idle' });
      return { success: true, steps: stepCount };

    } catch (err) {
      logger.error(`Agent error: ${err.message}`);
      this._emit('error', { message: err.message });
      this._emit('status', { state: 'error' });
      await this.browser.close();
      this.running = false;
      throw err;
    }
  }

  /**
   * Execute a single action.
   */
  async _executeAction(actionObj, elements) {
    const { action, elementId, params } = actionObj;

    try {
      switch (action) {
        case 'navigate':
          return await this.browser.goto(params.url);
        case 'click':
          return await this.browser.clickElement(elementId, elements);
        case 'type':
          return await this.browser.clearAndType(params.text);
        case 'scroll':
          return await this.browser.scroll(params.direction, params.amount);
        case 'select_option':
          return await this.browser.selectOption(elementId, elements, params.value);
        case 'wait':
          return await this.browser.wait(params.ms);
        case 'pause_for_user':
          return 'Paused for user action';
        default:
          return `Unknown action: ${action}`;
      }
    } catch (err) {
      return `Error executing ${action}: ${err.message}`;
    }
  }

  /**
   * Self-correction: verify the last action had the intended effect.
   * If not, retry with feedback to the LLM.
   */
  async _verifySelfCorrect(actionObj, elements, task, elementListText, currentStep) {
    if (actionObj.action === 'type' && actionObj.params?.text) {
      // Find the last clicked element
      const lastClickedId = this._findLastClickedElementId();
      if (lastClickedId !== null) {
        await this.browser.wait(300);
        const currentValue = await this.browser.getElementValue(lastClickedId, elements);

        if (currentValue && currentValue.includes(actionObj.params.text)) {
          logger.success(`✓ Verified: field contains "${actionObj.params.text.substring(0, 30)}..."`);
          this._emit('action', {
            action: 'verify_success',
            elementId: lastClickedId,
            params: { expected: actionObj.params.text, actual: currentValue },
            reasoning: 'Action verified successfully',
            step: null,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Verification failed — retry with feedback
        logger.error(`✗ Verification failed: expected "${actionObj.params.text.substring(0, 30)}..." but got "${currentValue}"`);
        this._emit('action', {
          action: 'verify_failed',
          elementId: lastClickedId,
          params: { expected: actionObj.params.text, actual: currentValue },
          reasoning: 'Action failed verification — retrying',
          step: null,
          timestamp: new Date().toISOString(),
        });

        // Retry: take new screenshot, annotate, ask LLM with failure context
        for (let retry = 0; retry < MAX_RETRIES_PER_ACTION; retry++) {
          logger.info(`🔄 Retry ${retry + 1}/${MAX_RETRIES_PER_ACTION}...`);

          const retryScreenshot = await this.browser.takeScreenshot();
          const retryElements = await this.browser.getInteractiveElements();
          const retryElementText = buildElementListText(retryElements);
          const { annotatedImageBase64: retryAnnotated } = await annotate(this.browser.page, retryElements);

          const failureMsg = `Typing "${actionObj.params.text}" failed. Element [${lastClickedId}] now shows "${currentValue || '(empty)'}". The text was not entered correctly. Try clicking element [${lastClickedId}] again first, then type.`;

          try {
            const { actionObj: retryAction } = await this.llm.retry(
              retryAnnotated, task, this.conversationHistory, retryElementText, failureMsg
            );

            const retryResult = await this._executeAction(retryAction, retryElements);
            logger.info(`Retry result: ${retryResult}`);
            break;
          } catch (err) {
            logger.error(`Retry ${retry + 1} failed: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * Look through conversation history to find the last element that was clicked.
   */
  _findLastClickedElementId() {
    for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
      const msg = this.conversationHistory[i];
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        try {
          const parsed = JSON.parse(msg.content.replace(/```(?:json)?\n?([\s\S]*?)```/g, '$1').trim().match(/\{[\s\S]*\}/)?.[0] || '{}');
          if (parsed.action === 'click' && parsed.elementId) {
            return parsed.elementId;
          }
        } catch (e) { /* ignore parse errors */ }
      }
    }
    return null;
  }
}

module.exports = Agent;
