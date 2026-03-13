import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { AIResponder } from './ai-responder.js';
import { 
  getEmailPassword, 
  getOpenAIKey, 
  isSpamLike, 
  isFromOwner, 
  buildDefaultReply 
} from './utils.js';

// Import handlers
import { isBanorteEmail, processBanorteEmail } from '../handlers/banorte.js';

export class MailProcessor {
  constructor(config) {
    this.config = config;
    this.aiResponder = new AIResponder(config);
  }

  /**
   * Process incoming emails
   */
  async process() {
    const result = { 
      ok: true, 
      processed: [], 
      skipped: [], 
      instructions: [],
      timestamp: new Date().toISOString()
    };

    let imap, smtp;
    
    try {
      // Get credentials
      const password = getEmailPassword();
      const openaiKey = getOpenAIKey();

      // Setup connections
      imap = new ImapFlow({
        host: this.config.mail.host,
        port: this.config.mail.imapPort,
        secure: true,
        auth: { 
          user: this.config.mail.user, 
          pass: password 
        },
        logger: false
      });

      smtp = nodemailer.createTransporter({
        host: this.config.mail.host,
        port: this.config.mail.smtpPort,
        secure: true,
        auth: { 
          user: this.config.mail.user, 
          pass: password 
        }
      });

      await imap.connect();
      const lock = await imap.getMailboxLock(this.config.mail.mailbox);

      try {
        // Get unseen emails
        const unseen = await imap.search({ seen: false });
        const uids = unseen.slice(-this.config.mail.maxPerCycle).reverse();

        for (const uid of uids) {
          const { source, envelope } = await imap.fetchOne(uid, { 
            source: true, 
            envelope: true 
          });
          const parsed = await simpleParser(source);

          const processResult = await this.processEmail(uid, parsed, smtp, openaiKey);
          
          if (processResult.type === 'processed') {
            result.processed.push(processResult.data);
          } else if (processResult.type === 'skipped') {
            result.skipped.push(processResult.data);
          } else if (processResult.type === 'instruction') {
            result.instructions.push(processResult.data);
          }

          // Mark as read
          await imap.messageFlagsAdd(uid, ['\\Seen']);
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      result.ok = false;
      result.error = error.message;
      console.error('Mail processing error:', error.message);
    } finally {
      if (imap) {
        try { await imap.logout(); } catch (e) {}
      }
    }

    return result;
  }

  /**
   * Process individual email
   */
  async processEmail(uid, parsed, smtp, openaiKey) {
    const fromText = parsed.from?.text ?? '';
    const fromAddress = parsed.from?.value?.[0]?.address ?? '';
    const subject = parsed.subject ?? '';
    const messageId = parsed.messageId ?? null;
    const text = (parsed.text ?? '').trim();

    // Check if this is a Banorte email (if handler enabled)
    if (this.config.handlers.banorte.enabled && isBanorteEmail(fromAddress)) {
      return this.processBanorteEmail(uid, parsed, messageId, fromText, subject);
    }

    // Check if from owner (treat as instruction)
    if (isFromOwner(fromAddress, this.config.behavior.ownerEmails)) {
      return {
        type: 'instruction',
        data: {
          uid,
          messageId,
          from: fromText,
          subject,
          body: text
        }
      };
    }

    // Check if spam
    if (isSpamLike({ subject, from: fromText, text }, this.config.behavior.spamKeywords)) {
      return {
        type: 'skipped',
        data: {
          uid,
          messageId,
          from: fromText,
          subject,
          reason: 'spam_like'
        }
      };
    }

    // Get reply-to address
    const toAddress = (parsed.replyTo?.value?.[0]?.address) || fromAddress;
    if (!toAddress) {
      return {
        type: 'skipped',
        data: {
          uid,
          messageId,
          from: fromText,
          subject,
          reason: 'no_reply_address'
        }
      };
    }

    // Skip auto-reply if disabled
    if (!this.config.behavior.autoReply) {
      return {
        type: 'skipped',
        data: {
          uid,
          messageId,
          from: fromText,
          subject,
          reason: 'auto_reply_disabled'
        }
      };
    }

    // Generate reply
    return this.generateAndSendReply(
      uid, messageId, fromText, toAddress, subject, text, smtp, openaiKey
    );
  }

  /**
   * Process Banorte email using the handler
   */
  async processBanorteEmail(uid, parsed, messageId, fromText, subject) {
    // Verify authentication headers for additional security
    const authResults = (parsed.headers?.get('authentication-results') || '').toString().toLowerCase();
    const spfPass = authResults ? authResults.includes('spf=pass') : true;
    const dkimPass = authResults ? authResults.includes('dkim=pass') : true;

    if (!spfPass || !dkimPass) {
      console.warn('[banorte] Email failed authentication, skipping:', fromText);
      return {
        type: 'skipped',
        data: {
          uid,
          messageId,
          from: fromText,
          subject,
          reason: 'banorte_auth_failed',
          authResults
        }
      };
    }

    let banorteResult = null;
    try {
      banorteResult = await processBanorteEmail(parsed, this.config.handlers.banorte);
    } catch (error) {
      console.error('[banorte] Processing error:', error.message);
    }

    return {
      type: 'processed',
      data: {
        uid,
        messageId,
        from: fromText,
        subject,
        type: 'banorte_transaction',
        banorte: banorteResult
      }
    };
  }

  /**
   * Generate and send reply
   */
  async generateAndSendReply(uid, messageId, fromText, toAddress, subject, text, smtp, openaiKey) {
    let replyBody;
    let usedAI = false;

    // Try AI generation first
    if (openaiKey) {
      try {
        replyBody = await this.aiResponder.generateReply({
          from: fromText,
          subject,
          body: text,
          apiKey: openaiKey
        });
        if (replyBody) {
          usedAI = true;
        }
      } catch (error) {
        console.error('AI reply generation failed:', error.message);
      }
    }

    // Fallback to default reply
    if (!replyBody) {
      const fallback = buildDefaultReply(subject, this.config.behavior.signature);
      replyBody = fallback.text;
    }

    // Prepare reply subject
    const replySubject = subject?.toLowerCase().startsWith('re:')
      ? subject
      : `Re: ${subject || ''}`.trim();

    // Send email
    const mail = {
      from: this.config.mail.user,
      to: toAddress,
      cc: this.config.behavior.ccAlways || undefined,
      subject: replySubject,
      text: replyBody,
      inReplyTo: messageId || undefined,
      references: messageId ? [messageId] : undefined
    };

    try {
      const info = await smtp.sendMail(mail);
      
      return {
        type: 'processed',
        data: {
          uid,
          messageId,
          from: fromText,
          to: toAddress,
          subject,
          sent: true,
          usedAI,
          replyPreview: replyBody.slice(0, 100) + (replyBody.length > 100 ? '...' : ''),
          smtpMessageId: info.messageId
        }
      };
    } catch (error) {
      console.error('Failed to send reply:', error.message);
      return {
        type: 'skipped',
        data: {
          uid,
          messageId,
          from: fromText,
          subject,
          reason: 'send_failed',
          error: error.message
        }
      };
    }
  }
}