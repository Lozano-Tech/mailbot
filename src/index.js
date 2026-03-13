#!/usr/bin/env node

import { MailProcessor } from './mail-processor.js';
import { loadConfig } from './utils.js';
import 'dotenv/config';

async function main() {
  try {
    const config = await loadConfig();
    const processor = new MailProcessor(config);
    
    console.log('Starting mailbot...');
    const result = await processor.process();
    
    // Output result as JSON for logging/monitoring
    console.log(JSON.stringify(result, null, 2));
    
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Fatal error:', error.message);
    const result = { 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    };
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}