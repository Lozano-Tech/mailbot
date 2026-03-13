import { loadPrompt } from './utils.js';

export class AIResponder {
  constructor(config) {
    this.config = config;
    this.systemPrompt = null;
  }

  /**
   * Initialize the responder by loading the system prompt
   */
  async init() {
    try {
      this.systemPrompt = loadPrompt(this.config.ai.promptFile);
    } catch (error) {
      throw new Error(`Failed to initialize AI responder: ${error.message}`);
    }
  }

  /**
   * Generate AI response using OpenAI API
   */
  async generateReply({ from, subject, body, apiKey }) {
    if (!apiKey) {
      return null; // No API key, will use fallback
    }

    if (!this.systemPrompt) {
      await this.init();
    }

    const userMessage = `Email received:
From: ${from}
Subject: ${subject}

${body.slice(0, 2000)}

---
Generate an appropriate response.`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: this.config.ai.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: this.config.ai.maxTokens,
          temperature: this.config.ai.temperature
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || null;
    } catch (error) {
      console.error('AI generation failed:', error.message);
      return null;
    }
  }
}