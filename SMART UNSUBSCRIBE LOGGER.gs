// ============================================================
// SMART UNSUBSCRIBE LOGGER
// Scans inbox for newsletters/marketing emails, scores them
// via Claude, and logs them to a Google Sheet for periodic review.
// Runs weekly and emails a summary with the sheet link.
//
// IMPORTANT SETUP NOTES
// ------------------------------------------------------------
// 1. Do NOT paste your Anthropic API key directly into this file.
//    Store it in Apps Script Properties instead:
//
//    Apps Script → Project Settings → Script Properties
//    Add property:
//      Name:  ANTHROPIC_API_KEY
//      Value: your Anthropic API key
//
// 2. Replace the placeholder values below:
//      SHEET_NAME
//      PROCESSED_LABEL
//      USER_TIMEZONE
//      MAX_THREADS_PER_RUN
//      SEND_SUMMARY_EMAIL
//
// 3. Run testSetup() manually once.
// 4. Then create a weekly time-based trigger for scanForNewsletters().
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

// Name of the Google Sheet where unsubscribe candidates will be logged.
// Example: 'Unsubscribe Tracker'
var SHEET_NAME = 'YOUR_SHEET_NAME_HERE';

// Gmail label applied after a thread has been processed.
// Example: 'unsubscribe-logged'
var PROCESSED_LABEL = 'YOUR_PROCESSED_LABEL_HERE';

// Your primary timezone in IANA format.
// Examples:
//   'America/Chicago'
//   'America/New_York'
//   'America/Los_Angeles'
//   'Europe/London'
var USER_TIMEZONE = 'YOUR_TIMEZONE_HERE';

// Maximum number of candidate threads to scan per run.
// Keep this modest to avoid API/token overload.
var MAX_THREADS_PER_RUN = 50;

// Whether to send a weekly summary email to the active Google user.
var SEND_SUMMARY_EMAIL = true;


// ============================================================
// MAIN ENTRY POINT — run once weekly via time-based trigger
// ============================================================
function scanForNewsletters() {
  var ss    = getOrCreateSheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var label = getOrCreateLabel(PROCESSED_LABEL);

  // Use last run time if available, otherwise scan all time.
  var lastRun   = getLastRunTime(sheet);
  var cutoff    = lastRun ? lastRun : new Date(0);
  var cutoffStr = Utilities.formatDate(cutoff, USER_TIMEZONE, 'yyyy/MM/dd');

  Logger.log('Scanning since: ' + (lastRun ? cutoffStr : 'beginning of time'));

  var query = [
    'in:inbox',
    'after:' + cutoffStr,
    '-label:' + PROCESSED_LABEL,
    '(unsubscribe OR "email preferences" OR "manage preferences" OR "opt out" OR "view in browser" OR "email marketing")'
  ].join(' ');

  var threads = GmailApp.search(query, 0, MAX_THREADS_PER_RUN);

  if (threads.length === 0) {
    Logger.log('No new newsletter threads found.');
    saveLastRunTime(sheet);

    if (SEND_SUMMARY_EMAIL) {
      sendSummaryEmail(ss, 0, 0);
    }

    return;
  }

  Logger.log('Found ' + threads.length + ' candidate thread(s).');

  // Load existing senders from sheet to avoid duplicates.
  var existingSenders = getExistingSenders(sheet);

  var newRows      = [];
  var updatedCount = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread  = threads[i];
    var message = thread.getMessages()[0];

    try {
      var sender     = extractSenderEmail(message.getFrom());
      var senderName = extractSenderName(message.getFrom());
      var subject    = message.getSubject();

      // NOTE:
      // This sends the first 3,000 characters of the email body to Claude.
      // Do not run this on emails that may contain sensitive personal,
      // financial, client, legal, medical, or confidential information.
      var body = message.getPlainBody().substring(0, 3000);

      var date = message.getDate();

      // Skip if we already have an entry for this sender — just update counts.
      if (existingSenders[sender]) {
        updateExistingRow(sheet, existingSenders[sender], date);
        thread.addLabel(label);
        updatedCount++;
        continue;
      }

      Logger.log('Analyzing: ' + sender);

      var analysis = callClaude(senderName, sender, subject, body);

      if (!analysis) {
        Logger.log('Claude returned nothing for: ' + sender);
        continue;
      }

      var row = [
        senderName,                                                   // A: Sender Name
        sender,                                                       // B: Sender Email
        analysis.category || '',                                      // C: Category
        analysis.valueScore || '',                                    // D: Value Score
        analysis.frequency || '',                                     // E: Estimated Frequency
        analysis.summary || '',                                       // F: What it is
        analysis.recommendation || '',                                // G: Keep / Unsubscribe / Review
        Utilities.formatDate(date, USER_TIMEZONE, 'MMM d, yyyy'),     // H: First Seen
        Utilities.formatDate(date, USER_TIMEZONE, 'MMM d, yyyy'),     // I: Last Seen
        1,                                                            // J: Count
        analysis.unsubscribeLink || '',                               // K: Unsubscribe Link
        'Pending'                                                     // L: Action Taken
      ];

      newRows.push(row);
      existingSenders[sender] = {
        rowIndex: sheet.getLastRow() + newRows.length
      };

      thread.addLabel(label);

    } catch (e) {
      Logger.log('Error processing thread "' + thread.getFirstMessageSubject() + '": ' + e.toString());
      Logger.log('Stack: ' + e.stack);
    }
  }

  if (newRows.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, newRows.length, newRows[0].length).setValues(newRows);
    applyRowFormatting(sheet, startRow, newRows.length);
    Logger.log('Added ' + newRows.length + ' new sender(s) to the sheet.');
  } else {
    Logger.log('No new senders to add.');
  }

  sortSheet(sheet);

  saveLastRunTime(sheet);
  Logger.log('Last run time saved: ' + new Date().toISOString());

  if (SEND_SUMMARY_EMAIL) {
    sendSummaryEmail(ss, newRows.length, updatedCount);
  }
}


// ============================================================
// SEND WEEKLY SUMMARY EMAIL
// ============================================================
function sendSummaryEmail(ss, newCount, updatedCount) {
  var sheetUrl = ss.getUrl();
  var recipient = Session.getActiveUser().getEmail();

  var subject = 'Weekly Unsubscribe Tracker Update';

  var body = [
    'Your weekly newsletter scan is complete.',
    '',
    'New senders logged this week: ' + newCount,
    'Existing senders updated:     ' + updatedCount,
    '',
    'Review your tracker here:',
    sheetUrl,
    '',
    'Unsubscribe candidates are sorted to the top, with the lowest value scores first.'
  ].join('\n');

  GmailApp.sendEmail(recipient, subject, body);
  Logger.log('Summary email sent to: ' + recipient);
}


// ============================================================
// CALL CLAUDE TO ANALYZE THE EMAIL
// ============================================================
function callClaude(senderName, senderEmail, subject, body) {
  var anthropicApiKey = getAnthropicApiKey();

  var systemPrompt = [
    'You are an email analyst. Analyze this newsletter or marketing email and return a JSON object.',
    'Be concise and direct. Return ONLY valid JSON, no markdown, no explanation.',
    '',
    'Fields to return:',
    '- category: one of "Newsletter", "Marketing/Promotional", "Product Updates", "Social/Community", "Deals/Offers", "News digest", "Other"',
    '- valueScore: integer 1-10 where 1 = pure spam/no value, 5 = occasionally useful, 10 = genuinely valuable reading',
    '- frequency: estimated send frequency, one of "Daily", "Weekly", "Monthly", "Irregular"',
    '- summary: one sentence describing what this sender sends, max 15 words',
    '- recommendation: one of "Keep", "Review", "Unsubscribe"',
    '- unsubscribeLink: the unsubscribe URL if visible in the email body, otherwise empty string',
    '',
    'Recommendation guidance:',
    '- Keep: score 7-10',
    '- Review: score 4-6',
    '- Unsubscribe: score 1-3',
    '',
    'Value score guidance:',
    '1-3: Pure promotional, deals, or content the user likely never asked for',
    '4-6: Occasionally relevant but mostly noise',
    '7-10: Genuinely informative, professional, or content the user likely actively wants',
    '',
    'Example:',
    '{"category":"Newsletter","valueScore":3,"frequency":"Weekly","summary":"Promotional deals from an online retailer.","recommendation":"Unsubscribe","unsubscribeLink":"https://..."}'
  ].join('\n');

  var userContent = [
    'Sender name: ' + senderName,
    'Sender email: ' + senderEmail,
    'Subject: ' + subject,
    '',
    'Body:',
    body
  ].join('\n');

  var payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userContent
      }
    ]
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  var responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    Logger.log('Anthropic API error ' + responseCode + ': ' + response.getContentText());
    return null;
  }

  var data = JSON.parse(response.getContentText());
  var text = data.content[0].text.trim();

  text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    Logger.log('Failed to parse Claude response: ' + text);
    return null;
  }
}


// ============================================================
// GET ANTHROPIC API KEY FROM SCRIPT PROPERTIES
// ============================================================
function getAnthropicApiKey() {
  var key = PropertiesService
    .getScriptProperties()
    .getProperty('ANTHROPIC_API_KEY');

  if (!key) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Add it in Apps Script → Project Settings → Script Properties.'
    );
  }

  return key;
}


// ============================================================
// GET OR CREATE THE GOOGLE SHEET
// ============================================================
function getOrCreateSheet() {
  var files = DriveApp.getFilesByName(SHEET_NAME);

  if (files.hasNext()) {
    var file = files.next();
    Logger.log('Found existing sheet: ' + file.getUrl());
    return SpreadsheetApp.open(file);
  }

  var ss = SpreadsheetApp.create(SHEET_NAME);
  var sheet = ss.getActiveSheet();
  sheet.setName(SHEET_NAME);

  var headers = [
    'Sender Name',
    'Sender Email',
    'Category',
    'Value Score',
    'Frequency',
    'What It Sends',
    'Recommendation',
    'First Seen',
    'Last Seen',
    'Email Count',
    'Unsubscribe Link',
    'Action Taken'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setBackground('#1a1a2e');
  headerRange.setFontColor('#ffffff');
  headerRange.setFontWeight('bold');
  headerRange.setFontSize(11);

  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 90);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 280);
  sheet.setColumnWidth(7, 120);
  sheet.setColumnWidth(8, 100);
  sheet.setColumnWidth(9, 100);
  sheet.setColumnWidth(10, 90);
  sheet.setColumnWidth(11, 200);
  sheet.setColumnWidth(12, 120);

  sheet.setFrozenRows(1);

  Logger.log('Created new sheet: ' + ss.getUrl());
  return ss;
}


// ============================================================
// GET EXISTING SENDERS FROM SHEET
// ============================================================
function getExistingSenders(sheet) {
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {};
  }

  var data = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var senders = {};

  for (var i = 0; i < data.length; i++) {
    var email = data[i][0];

    if (email) {
      senders[email] = {
        rowIndex: i + 2
      };
    }
  }

  return senders;
}


// ============================================================
// UPDATE LAST SEEN DATE AND COUNT FOR EXISTING SENDER
// ============================================================
function updateExistingRow(sheet, senderMeta, date) {
  var row = senderMeta.rowIndex;

  var dateStr = Utilities.formatDate(date, USER_TIMEZONE, 'MMM d, yyyy');

  var countCell = sheet.getRange(row, 10);
  var lastSeen  = sheet.getRange(row, 9);

  lastSeen.setValue(dateStr);
  countCell.setValue((countCell.getValue() || 0) + 1);
}


// ============================================================
// APPLY ROW COLOR CODING BASED ON RECOMMENDATION
// ============================================================
function applyRowFormatting(sheet, startRow, numRows) {
  for (var i = 0; i < numRows; i++) {
    var row = startRow + i;

    var recommendation = sheet.getRange(row, 7).getValue();
    var range = sheet.getRange(row, 1, 1, 12);

    if (recommendation === 'Unsubscribe') {
      range.setBackground('#fce8e6');
    } else if (recommendation === 'Review') {
      range.setBackground('#fef9e7');
    } else if (recommendation === 'Keep') {
      range.setBackground('#e6f4ea');
    }

    var linkCell = sheet.getRange(row, 11);

    if (linkCell.getValue()) {
      linkCell.setFontColor('#1155CC');
    }

    sheet.getRange(row, 4).setHorizontalAlignment('center');
    sheet.getRange(row, 10).setHorizontalAlignment('center');
  }
}


// ============================================================
// SORT SHEET BY VALUE SCORE ASCENDING
// ============================================================
function sortSheet(sheet) {
  var lastRow = sheet.getLastRow();

  if (lastRow < 3) {
    return;
  }

  sheet.getRange(2, 1, lastRow - 1, 12).sort({
    column: 4,
    ascending: true
  });
}


// ============================================================
// HELPER: EXTRACT EMAIL ADDRESS FROM "NAME <EMAIL>" FORMAT
// ============================================================
function extractSenderEmail(from) {
  var match = from.match(/<(.+?)>/);

  return match
    ? match[1].toLowerCase()
    : from.toLowerCase().trim();
}


// ============================================================
// HELPER: EXTRACT DISPLAY NAME FROM "NAME <EMAIL>" FORMAT
// ============================================================
function extractSenderName(from) {
  var match = from.match(/^(.+?)\s*</);

  if (match) {
    return match[1].replace(/"/g, '').trim();
  }

  return from.split('@')[0];
}


// ============================================================
// HELPER: GET OR CREATE GMAIL LABEL
// ============================================================
function getOrCreateLabel(name) {
  var label = GmailApp.getUserLabelByName(name);

  if (!label) {
    label = GmailApp.createLabel(name);
    Logger.log('Created Gmail label: ' + name);
  }

  return label;
}


// ============================================================
// HELPER: READ LAST RUN TIMESTAMP FROM SHEET CELL N1
// ============================================================
function getLastRunTime(sheet) {
  var cell = sheet.getRange('N1');
  var val = cell.getValue();

  if (!val || val === '') {
    return null;
  }

  var d = new Date(val);

  return isNaN(d.getTime()) ? null : d;
}


// ============================================================
// HELPER: SAVE CURRENT TIMESTAMP TO SHEET CELL N1
// ============================================================
function saveLastRunTime(sheet) {
  sheet.getRange('M1').setValue('Last Run:');
  sheet.getRange('M1').setFontWeight('bold');
  sheet.getRange('N1').setValue(new Date().toISOString());
}


// ============================================================
// ONE-TIME SETUP TEST
// Run this manually to verify everything is ready.
// ============================================================
function testSetup() {
  Logger.log('Checking setup...');

  var apiKey = getAnthropicApiKey();
  Logger.log('API key set: ' + (apiKey.length > 0 ? 'YES' : 'NO'));

  if (
    SHEET_NAME === 'YOUR_SHEET_NAME_HERE' ||
    PROCESSED_LABEL === 'YOUR_PROCESSED_LABEL_HERE' ||
    USER_TIMEZONE === 'YOUR_TIMEZONE_HERE'
  ) {
    throw new Error(
      'Replace placeholder values in the CONFIGURATION section before using this script.'
    );
  }

  Logger.log('Sheet name: ' + SHEET_NAME);
  Logger.log('Processed label: ' + PROCESSED_LABEL);
  Logger.log('Timezone: ' + USER_TIMEZONE);
  Logger.log('Max threads per run: ' + MAX_THREADS_PER_RUN);
  Logger.log('Send summary email: ' + SEND_SUMMARY_EMAIL);

  var ss = getOrCreateSheet();
  Logger.log('Sheet URL: ' + ss.getUrl());

  var label = getOrCreateLabel(PROCESSED_LABEL);
  Logger.log('Gmail label ready: ' + label.getName());

  Logger.log('Setup looks good. Set a weekly trigger on scanForNewsletters.');
}
