// ============================================================
// EMAIL → GOOGLE CALENDAR AUTOMATION
// Watches a designated Gmail address for forwarded emails,
// classifies them via Claude, and creates calendar events or
// review blocks automatically.
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
//      TARGET_ADDRESS
//      USER_TIMEZONE
//      USER_LOCATION_CONTEXT, optional
//      REVIEW_WINDOW_START
//      REVIEW_WINDOW_END
//
// 3. Run testSetup() manually once.
// 4. Then create a time-based trigger for processCalendarEmails()
//    to run every 10 minutes.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

// Your forwarding / intake email address.
// Example: 'yourname+cal@gmail.com'
var TARGET_ADDRESS = 'YOUR_EMAIL_PLUS_ADDRESS_HERE';

// Gmail label applied after a thread has been processed.
// You can leave this as-is or rename it.
var PROCESSED_LABEL = 'cal-processed';

// Your primary timezone in IANA format.
// Examples:
//   'America/Chicago'
//   'America/New_York'
//   'America/Los_Angeles'
//   'Europe/London'
var USER_TIMEZONE = 'YOUR_TIMEZONE_HERE';

// Optional location context to help Claude infer timezones.
// Keep this broad if you do not want to expose a precise city.
// Examples:
//   'Central Time, United States'
//   'Madison, WI'
//   'New York City'
//   ''
var USER_LOCATION_CONTEXT = 'OPTIONAL_LOCATION_CONTEXT_HERE';

// Review block scheduling window, using 24-hour time.
// Example: 10 to 15 means 10:00 AM through 3:00 PM.
var REVIEW_WINDOW_START = 10;
var REVIEW_WINDOW_END   = 15;


// ============================================================
// MAIN ENTRY POINT — triggered every 10 minutes by Apps Script
// ============================================================
function processCalendarEmails() {
  var label = getOrCreateLabel(PROCESSED_LABEL);
  var threads = GmailApp.search('to:' + TARGET_ADDRESS + ' -label:' + PROCESSED_LABEL);

  if (threads.length === 0) {
    Logger.log('No new emails to process.');
    return;
  }

  Logger.log('Found ' + threads.length + ' thread(s) to process.');

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();

    for (var j = 0; j < messages.length; j++) {
      var message = messages[j];

      try {
        processMessage(message);
      } catch (e) {
        Logger.log('Error processing message "' + message.getSubject() + '": ' + e.toString());
        Logger.log('Stack: ' + e.stack);
      }
    }

    // Mark thread as read and apply processed label.
    thread.markRead();
    thread.addLabel(label);
  }
}


// ============================================================
// PROCESS A SINGLE EMAIL MESSAGE
// ============================================================
function processMessage(message) {
  var subject = message.getSubject();
  var body    = message.getPlainBody().substring(0, 6000); // cap to avoid token overload
  var date    = message.getDate();

  Logger.log('Processing: ' + subject);

  var claudeResponse = callClaude(subject, body, date);

  if (!claudeResponse || !claudeResponse.items || claudeResponse.items.length === 0) {
    Logger.log('Claude returned no actionable items for: ' + subject);
    return;
  }

  for (var k = 0; k < claudeResponse.items.length; k++) {
    var item = claudeResponse.items[k];

    if (item.type === 'event') {
      createCalendarEvent(item);
    } else if (item.type === 'review') {
      createReviewBlock(item);
    }
  }
}


// ============================================================
// CALL CLAUDE API
// ============================================================
function callClaude(subject, body, emailDate) {
  var anthropicApiKey = getAnthropicApiKey();

  var today = Utilities.formatDate(new Date(), USER_TIMEZONE, 'yyyy-MM-dd');
  var emailDateStr = Utilities.formatDate(emailDate, USER_TIMEZONE, 'yyyy-MM-dd');

  var locationLine = USER_LOCATION_CONTEXT && USER_LOCATION_CONTEXT !== 'OPTIONAL_LOCATION_CONTEXT_HERE'
    ? 'The user location/timezone context is: ' + USER_LOCATION_CONTEXT + '.'
    : 'The user timezone is ' + USER_TIMEZONE + '.';

  var systemPrompt = [
    'You are a calendar assistant. You read forwarded emails and extract actionable calendar items.',
    'Today is ' + today + '. The email was sent on ' + emailDateStr + '.',
    locationLine,
    '',
    'For each email, return a JSON object with an "items" array. Each item must be one of:',
    '',
    '1. TYPE: "event" — use when the email describes a specific event with a date/time, such as meetings, reservations, concerts, flights, restaurant bookings, sports events, ticket confirmations, etc.',
    '   Fields: type, title, start, end, location, description, timeZone',
    '   - start and end must be ISO 8601 datetime strings.',
    '   - If no end time is given, estimate a reasonable duration.',
    '   - Always try to infer timezone from context: timezone abbreviations, venue city/country, or other geographic clues in the email.',
    '   - If the event is clearly in another city or country, use that location’s timezone.',
    '   - Only fall back to the user timezone if there are absolutely no timezone clues.',
    '   - One email may produce multiple events.',
    '',
    '2. TYPE: "review" — use when the email is something to read, research, or follow up on, such as articles, links, documents, vague tasks, "look into this", research topics, etc.',
    '   Fields: type, title, description, estimatedMinutes',
    '   - estimatedMinutes should be 30 for short/simple, 60 for standard, 90 for complex/multi-part.',
    '   - title should be concise and prefixed with "Review: "',
    '   - description should include the key content, links, or summary so it is self-contained.',
    '',
    'Return ONLY valid JSON. No markdown, no explanation.',
    '',
    'Example:',
    '{"items":[{"type":"event","title":"Dinner at Restaurant","start":"2026-05-23T19:00:00","end":"2026-05-23T21:00:00","location":"Restaurant Name, City","description":"Reservation confirmation details","timeZone":"America/Chicago"},{"type":"review","title":"Review: Article on interest rates","description":"Link: https://... Summary: ...","estimatedMinutes":60}]}'
  ].join('\n');

  var payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: 'Subject: ' + subject + '\n\n' + body
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

  // Strip any accidental markdown fences.
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
// CREATE A CALENDAR EVENT
// ============================================================
function createCalendarEvent(item) {
  var start = new Date(item.start);
  var end   = new Date(item.end);

  var eventOptions = {
    description: item.description || ''
  };

  if (item.location) {
    eventOptions.location = item.location;
  }

  if (item.timeZone) {
    eventOptions.timeZone = item.timeZone;
  }

  CalendarApp.getDefaultCalendar().createEvent(
    item.title,
    start,
    end,
    eventOptions
  );

  Logger.log('Created event: ' + item.title + ' on ' + item.start);
}


// ============================================================
// CREATE A REVIEW BLOCK IN THE NEXT AVAILABLE REVIEW WINDOW
// ============================================================
function createReviewBlock(item) {
  var durationMs = (item.estimatedMinutes || 60) * 60 * 1000;
  var slot = findNextOpenSlot(durationMs);

  if (!slot) {
    Logger.log('No open slot found for review block: ' + item.title + '. Scheduling at default fallback slot.');
    slot = getDefaultSlot(durationMs);
  }

  var end = new Date(slot.getTime() + durationMs);

  CalendarApp.getDefaultCalendar().createEvent(
    item.title,
    slot,
    end,
    {
      description: item.description || ''
    }
  );

  Logger.log('Created review block: ' + item.title + ' at ' + slot);
}


// ============================================================
// FIND NEXT OPEN CALENDAR SLOT INSIDE REVIEW WINDOW
// Searches up to 7 days ahead
// ============================================================
function findNextOpenSlot(durationMs) {
  var cal = CalendarApp.getDefaultCalendar();

  // Start searching from tomorrow.
  var searchDate = new Date();
  searchDate.setDate(searchDate.getDate() + 1);

  for (var day = 0; day < 7; day++) {
    var dayStart = new Date(searchDate);
    dayStart.setHours(REVIEW_WINDOW_START, 0, 0, 0);

    var dayEnd = new Date(searchDate);
    dayEnd.setHours(REVIEW_WINDOW_END, 0, 0, 0);

    var events = cal.getEvents(dayStart, dayEnd);

    // Build a sorted list of busy intervals.
    var busy = events.map(function(e) {
      return {
        start: e.getStartTime().getTime(),
        end: e.getEndTime().getTime()
      };
    }).sort(function(a, b) {
      return a.start - b.start;
    });

    // Walk through the window looking for a gap.
    var cursor = dayStart.getTime();
    var found = true;

    for (var b = 0; b < busy.length; b++) {
      if (cursor + durationMs <= busy[b].start) {
        break;
      }

      cursor = Math.max(cursor, busy[b].end);

      if (cursor + durationMs > dayEnd.getTime()) {
        found = false;
        break;
      }
    }

    if (found && cursor + durationMs <= dayEnd.getTime()) {
      return new Date(cursor);
    }

    searchDate.setDate(searchDate.getDate() + 1);
  }

  return null;
}


// ============================================================
// FALLBACK SLOT IF NO OPEN REVIEW BLOCK IS FOUND
// Defaults to review window start time tomorrow
// ============================================================
function getDefaultSlot(durationMs) {
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(REVIEW_WINDOW_START, 0, 0, 0);
  return tomorrow;
}


// ============================================================
// HELPER: GET OR CREATE A GMAIL LABEL
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
// ONE-TIME SETUP TEST
// Run this manually once to verify configuration.
// ============================================================
function testSetup() {
  Logger.log('Checking setup...');

  var apiKey = getAnthropicApiKey();
  Logger.log('API key set: ' + (apiKey.length > 0 ? 'YES' : 'NO'));

  Logger.log('Target address: ' + TARGET_ADDRESS);
  Logger.log('Timezone: ' + USER_TIMEZONE);
  Logger.log('Location context: ' + USER_LOCATION_CONTEXT);
  Logger.log('Review window: ' + REVIEW_WINDOW_START + ':00–' + REVIEW_WINDOW_END + ':00');

  if (
    TARGET_ADDRESS === 'YOUR_EMAIL_PLUS_ADDRESS_HERE' ||
    USER_TIMEZONE === 'YOUR_TIMEZONE_HERE'
  ) {
    throw new Error(
      'Replace placeholder values in the CONFIGURATION section before using this script.'
    );
  }

  var label = getOrCreateLabel(PROCESSED_LABEL);
  Logger.log('Gmail label ready: ' + label.getName());

  var cal = CalendarApp.getDefaultCalendar();
  Logger.log('Calendar ready: ' + cal.getName());

  Logger.log('Setup looks good. You can now set the trigger on processCalendarEmails.');
}
