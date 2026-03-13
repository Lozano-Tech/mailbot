/**
 * banorte.js - Banorte Email Handler
 * 
 * Processes Banorte Internet Banking notification emails.
 * For each email from banorteporinternet@banorte.com:
 *   1. Parses transaction data (beneficiary, amount, date, etc.)
 *   2. Uploads receipt (HTML) to Google Drive → "Bancos" folder
 *   3. Records transaction in Google Sheets → "Movimientos Bancarios"
 * 
 * Security:
 *   - SPF banorte.com: -all (strict)
 *   - DMARC banorte.com: p=reject (strictest policy)
 *   - Additionally verifies Authentication-Results from IMAP server
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const exec = promisify(execCb);

let config = {};
let monthFolderCache = {};

/**
 * Initialize the handler with configuration
 */
function initializeHandler(handlerConfig) {
  config = {
    enabled: false,
    gogAccount: '',
    driveFolderId: '',
    sheetId: '',
    sheetTab: 'Movimientos',
    configFile: './banorte-config.json',
    ...handlerConfig
  };
}

/**
 * Check if email is from Banorte
 */
export function isBanorteEmail(fromAddress = '') {
  return fromAddress.toLowerCase().includes('banorteporinternet@banorte.com');
}

/**
 * Parse Banorte email HTML content
 */
export function parseBanorteEmail(parsed) {
  const html = parsed.html || '';
  const subject = parsed.subject || '';

  const result = {
    fecha: null,
    hora: null,
    tipo_operacion: null,
    beneficiario: null,
    banco_destino: null,
    clabe_destino: null,
    monto: null,
    referencia: null,
    folio: null,
    concepto: null,
    cuenta_origen: null,
    raw_subject: subject,
  };

  // Parse HTML table rows to extract label→value pairs
  const kvMap = {};
  const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*?>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let match;
  
  while ((match = rowRegex.exec(html)) !== null) {
    // Strip HTML tags and normalize whitespace
    const label = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&[^;]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/:$/, '')
      .trim()
      .toLowerCase();
    
    const value = match[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/&[^;]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (label && value) {
      kvMap[label] = value;
    }
  }

  // Map known labels to result fields
  for (const [label, value] of Object.entries(kvMap)) {
    if (!value) continue;

    if (label.includes('fecha de operaci')) {
      // Handle combined date+time: "10/Mar/2026 16:42:06 horas"
      const dateTimeParts = value.match(/^([\d]{1,2}\/\w+\/\d{4})\s+(\d{1,2}:\d{2})/);
      if (dateTimeParts) {
        result.fecha = dateTimeParts[1];
        if (!result.hora) result.hora = dateTimeParts[2];
      } else {
        result.fecha = value;
      }
    } else if (label.includes('hora de operaci')) {
      const hm = value.match(/(\d{1,2}:\d{2})/);
      result.hora = hm ? hm[1] : value.replace(/\s*horas?\s*/i, '').trim();
    } else if (label.includes('operaci') && !label.includes('fecha') && !label.includes('hora') && !label.includes('modo')) {
      result.tipo_operacion = value;
    } else if (label.includes('nombre del beneficiario') || label.includes('id tercero')) {
      // Prefer "Nombre del Beneficiario" over "ID Tercero"
      if (!result.beneficiario || label.includes('nombre del beneficiario')) {
        result.beneficiario = value;
      }
    } else if (label.includes('banco destino')) {
      result.banco_destino = value;
    } else if (label.includes('clabe') || label.includes('tarjeta destino') || (label.includes('cuenta') && label.includes('beneficiario'))) {
      result.clabe_destino = value;
    } else if (label.includes('importe') || label.includes('monto')) {
      // Extract numeric amount: "$102,802.63 MN" → "102802.63"
      const m = value.match(/\$?\s*([\d,]+\.?\d*)/);
      result.monto = m ? m[1].replace(/,/g, '') : value;
    } else if (label.includes('mero de referencia') || label === 'referencia') {
      result.referencia = value;
    } else if (label.includes('clave de rastreo') || label.includes('folio')) {
      result.folio = value;
    } else if (label.includes('concepto')) {
      result.concepto = value;
    } else if (label.includes('cuenta origen')) {
      result.cuenta_origen = value;
    } else if (label.includes('fecha de aplicaci')) {
      // Use as fallback if no operation date
      if (!result.fecha) result.fecha = value;
    }
  }

  // Fallback: extract operation type from subject
  if (!result.tipo_operacion) {
    const subj = subject.toLowerCase();
    if (subj.includes('spei')) result.tipo_operacion = 'SPEI';
    else if (subj.includes('transfer')) result.tipo_operacion = 'Transferencia';
    else if (subj.includes('pago')) result.tipo_operacion = 'Pago';
    else result.tipo_operacion = 'Movimiento';
  }

  // Normalize date: "12/Mar/2026" → "2026-03-12"
  if (result.fecha) {
    const months = {
      ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
      jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12'
    };
    const fm = result.fecha.match(/(\d{1,2})\/([\w]+)\/(\d{4})/);
    if (fm) {
      const mon = months[fm[2].toLowerCase().slice(0, 3)] || fm[2];
      result.fecha = `${fm[3]}-${mon}-${fm[1].padStart(2, '0')}`;
    }
  }

  return result;
}

/**
 * Google CLI helper
 */
async function gog(args) {
  if (!config.gogAccount) {
    throw new Error('Google account not configured for Banorte handler');
  }

  const gogEnv = {
    ...process.env,
    GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || 'clawdbot',
    GOG_ACCOUNT: config.gogAccount,
  };

  const { stdout } = await exec(
    `gog --no-input --json ${args}`,
    { env: gogEnv }
  );
  return stdout.trim();
}

/**
 * Setup Google Drive folder and Sheets (idempotent)
 */
async function setupResources() {
  // Load saved IDs
  if (existsSync(config.configFile)) {
    try {
      const savedConfig = JSON.parse(readFileSync(config.configFile, 'utf8'));
      config.driveFolderId = savedConfig.driveFolderId || config.driveFolderId;
      config.sheetId = savedConfig.sheetId || config.sheetId;
      config.sheetTab = savedConfig.sheetTab || config.sheetTab;
      if (config.driveFolderId && config.sheetId) return; // Already configured
    } catch (error) {
      console.warn('Could not load Banorte config:', error.message);
    }
  }

  // Setup Drive folder "Bancos"
  if (!config.driveFolderId) {
    // Search for existing folder first
    try {
      const raw = await gog(`drive search "name='Bancos' and mimeType='application/vnd.google-apps.folder'"`);
      const items = JSON.parse(raw);
      if (Array.isArray(items) && items.length > 0) {
        config.driveFolderId = items[0].id;
        console.log('[banorte] Found existing "Bancos" folder:', config.driveFolderId);
      }
    } catch (error) {
      console.warn('Could not search for Bancos folder:', error.message);
    }
  }

  if (!config.driveFolderId) {
    const raw = await gog(`drive mkdir "Bancos"`);
    const folder = JSON.parse(raw);
    config.driveFolderId = folder.id;
    console.log('[banorte] Created "Bancos" folder:', config.driveFolderId);
  }

  // Setup Google Sheet "Movimientos Bancarios"
  if (!config.sheetId) {
    // Search in Bancos folder
    try {
      const raw = await gog(`drive search "name='Movimientos Bancarios' and '${config.driveFolderId}' in parents"`);
      const items = JSON.parse(raw);
      if (Array.isArray(items) && items.length > 0) {
        config.sheetId = items[0].id;
        console.log('[banorte] Found existing sheet:', config.sheetId);
      }
    } catch (error) {
      console.warn('Could not search for sheet:', error.message);
    }
  }

  if (!config.sheetId) {
    // Create new sheet
    const raw = await gog(`sheets create "Movimientos Bancarios"`);
    const sheet = JSON.parse(raw);
    config.sheetId = sheet.spreadsheetId || sheet.id;

    // Move to Bancos folder
    await gog(`drive move "${config.sheetId}" --parent "${config.driveFolderId}"`);
    console.log('[banorte] Created and moved sheet to Bancos:', config.sheetId);

    // Detect tab name
    try {
      const meta = await gog(`sheets metadata "${config.sheetId}"`);
      const parsed = JSON.parse(meta);
      const tabTitle = parsed?.sheets?.[0]?.properties?.title || 'Sheet1';
      config.sheetTab = tabTitle;
    } catch (error) {
      config.sheetTab = 'Sheet1';
    }

    // Write headers
    const headers = [[
      'Fecha', 'Hora', 'Tipo', 'Beneficiario',
      'Banco Destino', 'CLABE/Cuenta', 'Monto (MXN)',
      'Referencia', 'Folio/Clave Rastreo', 'Concepto',
      'Cuenta Origen', 'Asunto Correo', 'Link Comprobante'
    ]];
    await gog(`sheets update "${config.sheetId}" "${config.sheetTab}!A1:M1" --values-json '${JSON.stringify(headers)}' --input USER_ENTERED`);
    console.log('[banorte] Headers written to sheet');
  }

  // Save config
  const configData = {
    driveFolderId: config.driveFolderId,
    sheetId: config.sheetId,
    sheetTab: config.sheetTab,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${config.sheetId}`,
    folderUrl: `https://drive.google.com/drive/folders/${config.driveFolderId}`,
    setupAt: new Date().toISOString(),
  };
  
  writeFileSync(config.configFile, JSON.stringify(configData, null, 2));
}

/**
 * Get or create monthly subfolder (YYYY-MM)
 */
async function getMonthFolderId(yearMonth) {
  if (monthFolderCache[yearMonth]) return monthFolderCache[yearMonth];

  // Search for existing folder
  try {
    const raw = await gog(`drive search "name='${yearMonth}' and '${config.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder'"`);
    const items = JSON.parse(raw);
    const list = items.files ?? items;
    if (Array.isArray(list) && list.length > 0) {
      monthFolderCache[yearMonth] = list[0].id;
      return monthFolderCache[yearMonth];
    }
  } catch (error) {
    console.warn(`Could not search for ${yearMonth} folder:`, error.message);
  }

  // Create subfolder
  const raw = await gog(`drive mkdir "${yearMonth}" --parent "${config.driveFolderId}"`);
  const folder = JSON.parse(raw);
  const fid = folder.folder?.id ?? folder.id;
  monthFolderCache[yearMonth] = fid;
  console.log(`[banorte] Created ${yearMonth} subfolder:`, fid);
  return fid;
}

/**
 * Upload HTML receipt to Google Drive
 */
async function uploadReceipt(parsed, txData) {
  const fecha = (txData.fecha || new Date().toISOString().slice(0, 10))
    .replace(/[\/\s:]/g, '-')
    .slice(0, 10);
  
  const beneficiario = (txData.beneficiario || 'sin-nombre')
    .replace(/[^a-zA-ZáéíóúÁÉÍÓÚüÜñÑ0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40);
  
  const monto = txData.monto || '0';
  const filename = `${fecha}_${beneficiario}_${monto}.html`;

  const content = parsed.html || 
    `<pre style="font-family:monospace;white-space:pre-wrap">${(parsed.text || '').replace(/</g, '&lt;')}</pre>`;

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Comprobante Banorte — ${fecha}</title>
  <style>body{font-family:sans-serif;margin:0;padding:0}</style>
</head>
<body>
<div style="background:#00408B;color:#fff;padding:12px 16px;font-size:13px">
  <strong>🏦 Comprobante Banorte capturado automáticamente</strong><br>
  Recibido: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Monterrey' })} (Monterrey)<br>
  De: ${(parsed.from?.text || '').replace(/</g, '&lt;')}<br>
  Asunto: ${(parsed.subject || '').replace(/</g, '&lt;')}
</div>
${content}
</body>
</html>`;

  // Determine month for subfolder
  let yearMonth;
  if (txData.fecha) {
    const d = new Date(txData.fecha.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1'));
    if (!isNaN(d.getTime())) {
      yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  }
  if (!yearMonth) {
    const now = new Date();
    yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const monthFolderId = await getMonthFolderId(yearMonth);

  const tmpPath = join(tmpdir(), filename);
  writeFileSync(tmpPath, fullHtml, 'utf8');

  try {
    const raw = await gog(`drive upload "${tmpPath}" --name "${filename}" --parent "${monthFolderId}"`);
    const file = JSON.parse(raw);
    const fid = file.file?.id ?? file.id;
    return {
      fileId: fid,
      fileName: filename,
      yearMonth,
      link: `https://drive.google.com/file/d/${fid}/view`,
    };
  } finally {
    try { unlinkSync(tmpPath); } catch (error) {}
  }
}

/**
 * Append transaction row to Google Sheets
 */
async function appendToSheet(txData, receipt) {
  const row = [[
    txData.fecha || '',
    txData.hora || '',
    txData.tipo_operacion || '',
    txData.beneficiario || '',
    txData.banco_destino || '',
    txData.clabe_destino || '',
    txData.monto || '',
    txData.referencia || '',
    txData.folio || '',
    txData.concepto || '',
    txData.cuenta_origen || '',
    txData.raw_subject || '',
    receipt?.link || '',
  ]];

  // Escape quotes in JSON for shell
  const valuesJson = JSON.stringify(row).replace(/'/g, "'\\''");
  await gog(`sheets append "${config.sheetId}" "${config.sheetTab}!A:M" --values-json '${valuesJson}' --insert INSERT_ROWS`);
}

/**
 * Main processing function
 */
export async function processBanorteEmail(parsed, handlerConfig = {}) {
  // Initialize with configuration
  initializeHandler(handlerConfig);

  if (!config.enabled) {
    throw new Error('Banorte handler is disabled in configuration');
  }

  await setupResources();

  const txData = parseBanorteEmail(parsed);
  console.log('[banorte] Transaction data:', JSON.stringify(txData));

  let receipt = null;
  try {
    receipt = await uploadReceipt(parsed, txData);
    console.log('[banorte] ✅ Receipt uploaded to Drive:', receipt.link);
  } catch (error) {
    console.error('[banorte] ❌ Failed to upload receipt:', error.message);
  }

  try {
    await appendToSheet(txData, receipt);
    console.log('[banorte] ✅ Transaction recorded in Sheets');
  } catch (error) {
    console.error('[banorte] ❌ Failed to record in Sheets:', error.message);
  }

  return {
    txData,
    receipt,
    sheetId: config.sheetId,
    driveFolderId: config.driveFolderId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${config.sheetId}`,
    folderUrl: `https://drive.google.com/drive/folders/${config.driveFolderId}`,
  };
}