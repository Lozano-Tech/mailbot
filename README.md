# 🤖 Mailbot

An intelligent email auto-responder with AI-powered replies and extensible custom handlers.

## What It Does

Mailbot monitors your email inbox and automatically responds to incoming messages using OpenAI's GPT models or fallback responses. It's designed to handle customer service inquiries, acknowledgments, and routine email communication while filtering out spam and preserving important messages from designated contacts.

## Features

- 🤖 **AI-Powered Responses** - Uses OpenAI GPT models for contextual email replies
- 📧 **IMAP/SMTP Integration** - Works with standard email servers
- 🛡️ **Spam Detection** - Configurable keyword-based spam filtering
- 👥 **Owner Recognition** - Special handling for emails from designated addresses
- 🏦 **Custom Handlers** - Extensible system for specific email types (includes Banorte banking handler)
- 📋 **Comprehensive Logging** - Detailed processing results in JSON format
- 🔧 **Flexible Configuration** - Environment variables and JSON config support

## Quick Start

1. **Clone and install:**
   ```bash
   git clone <your-repo-url>
   cd mailbot
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   cp config.example.json config.json
   ```

3. **Edit configuration files:**
   - Set your email credentials in `.env`
   - Configure behavior and handlers in `config.json`
   - Customize the AI prompt in `prompts/default.md`

4. **Run:**
   ```bash
   npm start
   ```

## Configuration

### Environment Variables

Create `.env` file with these required variables:

```bash
# Email server settings
MAIL_HOST=mail.example.com
MAIL_USER=bot@example.com
MAIL_PASS=your_email_password

# Optional settings
OPENAI_API_KEY=sk-your-openai-api-key
CC_ALWAYS=admin@example.com
```

### Configuration File

The `config.json` file controls mailbot behavior:

```json
{
  "mail": {
    "host": "mail.example.com",      // SMTP/IMAP server
    "imapPort": 993,                 // IMAP port (usually 993 for SSL)
    "smtpPort": 465,                 // SMTP port (usually 465 for SSL)
    "user": "bot@example.com",       // Email address
    "mailbox": "INBOX",              // IMAP mailbox to monitor
    "maxPerCycle": 10                // Max emails to process per run
  },
  "ai": {
    "provider": "openai",            // AI provider (currently only OpenAI)
    "model": "gpt-4o-mini",          // OpenAI model to use
    "maxTokens": 500,                // Maximum response length
    "temperature": 0.7,              // Creativity level (0-1)
    "promptFile": "./prompts/default.md" // Path to system prompt
  },
  "behavior": {
    "ownerEmails": [                 // Emails that won't get auto-replies
      "owner@example.com"
    ],
    "ccAlways": "",                  // Email to CC on all replies
    "spamKeywords": [...],           // Keywords for spam detection
    "autoReply": true,               // Enable/disable auto-replies
    "signature": "Your Bot Assistant" // Email signature
  },
  "handlers": {
    "banorte": {                     // Mexican banking integration
      "enabled": false,              // Enable Banorte handler
      "gogAccount": "",              // Google account for Drive/Sheets
      "driveFolderId": "",           // Google Drive folder ID
      "sheetId": "",                 // Google Sheets ID
      "sheetTab": "Movimientos"      // Sheet tab name
    }
  }
}
```

## AI Prompt Customization

Edit `prompts/default.md` to customize how the AI responds to emails. The file uses Markdown format and supports:

- Instructions on tone and style
- Company/service information
- Response guidelines
- Examples of good/bad responses

See `prompts/example-tech-company.md` for a real-world example.

## Setting Up as a Cron Job

To run mailbot automatically every 5 minutes:

```bash
# Edit crontab
crontab -e

# Add this line:
*/5 * * * * cd /path/to/mailbot && npm start >> /var/log/mailbot.log 2>&1
```

For more sophisticated scheduling, consider using PM2 or systemd services.

## Custom Email Handlers

Mailbot supports custom handlers for specific email types. Handlers are modules in the `handlers/` directory that export:

- `isHandlerEmail(fromAddress)` - Detection function
- `processHandlerEmail(parsed, config)` - Processing function

### Banorte Handler (Mexican Banking)

The included Banorte handler processes transaction notifications from Banorte Internet Banking:

1. **Parses transaction data** - Amount, beneficiary, reference, etc.
2. **Uploads receipts** - HTML email content to Google Drive
3. **Records transactions** - Data in Google Sheets spreadsheet

**Requirements:**
- `gog` CLI tool installed and configured
- Google Drive and Sheets API access
- Banorte Internet Banking notifications enabled

**Setup:**
```bash
# Install gog CLI
npm install -g gog-cli

# Authenticate with Google
gog auth login

# Enable in config.json
{
  "handlers": {
    "banorte": {
      "enabled": true,
      "gogAccount": "your-account@gmail.com"
    }
  }
}
```

The handler automatically creates:
- Google Drive folder: "Bancos" with monthly subfolders
- Google Sheet: "Movimientos Bancarios" with transaction log

## Adding New Handlers

Create a new handler file in `handlers/`:

```javascript
// handlers/my-handler.js

export function isMyHandlerEmail(fromAddress) {
  return fromAddress.includes('special-system@example.com');
}

export async function processMyHandlerEmail(parsed, handlerConfig) {
  // Process the email
  const data = extractData(parsed);
  
  // Do something with the data
  await saveToDatabase(data);
  
  return {
    success: true,
    data: data
  };
}
```

Register it in `src/mail-processor.js`:

```javascript
import { isMyHandlerEmail, processMyHandlerEmail } from '../handlers/my-handler.js';

// Add to processEmail method
if (this.config.handlers.myHandler?.enabled && isMyHandlerEmail(fromAddress)) {
  return this.processCustomEmail(uid, parsed, processMyHandlerEmail);
}
```

## API Reference

### Processing Results

Each run outputs a JSON result with:

```json
{
  "ok": true,                    // Overall success
  "processed": [...],            // Successfully processed emails
  "skipped": [...],              // Skipped emails (spam, errors, etc.)
  "instructions": [...],         // Emails from owners (treated as instructions)
  "timestamp": "2026-03-13T15:30:00.000Z"
}
```

### Email Types

- **Processed**: Regular emails that received auto-replies
- **Skipped**: Spam, errors, or emails without reply addresses
- **Instructions**: Emails from owner addresses (no auto-reply)
- **Handler**: Special emails processed by custom handlers

## Troubleshooting

### Common Issues

**"Missing environment variable" error:**
- Check that `.env` file exists and has correct variables
- Verify email credentials are valid

**"Failed to load configuration" error:**
- Ensure `config.json` exists and has valid JSON
- Check file permissions

**AI responses not working:**
- Verify `OPENAI_API_KEY` is set correctly
- Check OpenAI API quota and billing
- Fallback responses will be used if AI fails

**IMAP/SMTP connection issues:**
- Verify server settings and ports
- Check firewall and network connectivity
- Ensure email account allows IMAP/SMTP access

### Debugging

Run with detailed logging:
```bash
DEBUG=* npm start
```

Test configuration:
```bash
node -e "import('./src/utils.js').then(m => m.loadConfig().then(console.log))"
```

## Requirements

- **Node.js**: Version 18 or higher
- **Email Server**: IMAP/SMTP access
- **OpenAI API**: For AI responses (optional)
- **Google APIs**: For Banorte handler (optional)

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

For issues and questions:
- Check the troubleshooting section above
- Review configuration examples
- Open an issue on GitHub