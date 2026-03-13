import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Get environment variable with optional fallback
 */
export function env(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

/**
 * Load configuration from config.json with fallback to config.example.json
 */
export async function loadConfig() {
  const configPath = existsSync('./config.json') 
    ? './config.json' 
    : './config.example.json';
  
  try {
    const configContent = readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    // Override with environment variables where available
    if (process.env.MAIL_HOST) config.mail.host = process.env.MAIL_HOST;
    if (process.env.MAIL_USER) config.mail.user = process.env.MAIL_USER;
    if (process.env.IMAP_PORT) config.mail.imapPort = Number(process.env.IMAP_PORT);
    if (process.env.SMTP_PORT) config.mail.smtpPort = Number(process.env.SMTP_PORT);
    if (process.env.IMAP_MAILBOX) config.mail.mailbox = process.env.IMAP_MAILBOX;
    if (process.env.IMAP_MAX) config.mail.maxPerCycle = Number(process.env.IMAP_MAX);
    if (process.env.CC_ALWAYS) config.behavior.ccAlways = process.env.CC_ALWAYS;
    
    return config;
  } catch (error) {
    throw new Error(`Failed to load configuration: ${error.message}`);
  }
}

/**
 * Load email password from environment variable
 */
export function getEmailPassword() {
  return env('MAIL_PASS');
}

/**
 * Load OpenAI API key from environment variable (optional)
 */
export function getOpenAIKey() {
  return process.env.OPENAI_API_KEY || null;
}

/**
 * Load AI system prompt from file
 */
export function loadPrompt(promptFile) {
  try {
    const path = resolve(promptFile);
    if (!existsSync(path)) {
      throw new Error(`Prompt file not found: ${path}`);
    }
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    throw new Error(`Failed to load prompt file: ${error.message}`);
  }
}

/**
 * Check if email address is spam-like based on keywords
 */
export function isSpamLike({ subject = '', from = '', text = '' }, spamKeywords = []) {
  const content = `${subject} ${from} ${text}`.toLowerCase();
  return spamKeywords.some(keyword => content.includes(keyword.toLowerCase()));
}

/**
 * Check if email is from an owner (should not auto-reply)
 */
export function isFromOwner(fromAddress = '', ownerEmails = []) {
  const addr = fromAddress.toLowerCase();
  return ownerEmails.some(email => addr.includes(email.toLowerCase()));
}

/**
 * Build default reply when AI is not available
 */
export function buildDefaultReply(originalSubject, signature) {
  const subject = originalSubject?.toLowerCase().startsWith('re:')
    ? originalSubject
    : `Re: ${originalSubject || ''}`.trim();

  const text = [
    'Hello,',
    '',
    'Thank you for your email. I have received your message and will review it with our team.',
    'We will get back to you shortly with a response.',
    '',
    'Best regards,',
    signature
  ].join('\n');

  return { subject, text };
}