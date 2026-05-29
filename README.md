# Gmail Optimizations

A small collection of Google Apps Script automations that use Gmail, Google Calendar, Google Sheets, and Claude to reduce inbox clutter and turn forwarded emails into useful calendar actions.

This repo currently contains two standalone automations:

1. **Email → Google Calendar Automation**  
   Watches a designated Gmail intake address for forwarded emails, asks Claude to classify each email, and creates either calendar events or review blocks.

2. **Smart Unsubscribe Logger**  
   Scans Gmail for newsletters and marketing emails, asks Claude to score and summarize them, and logs unsubscribe candidates to a Google Sheet for periodic review.

Both scripts are designed to run inside **Google Apps Script** and use the **Anthropic Messages API** through `UrlFetchApp`.

---

## Repository contents

```text
gmail-optimizations/
├── GOOGLE CALENDAR AUTOMATION.gs
├── SMART UNSUBSCRIBE LOGGER.gs
└── README.md
```

| File | Purpose |
|---|---|
| `GOOGLE CALENDAR AUTOMATION.gs` | Processes forwarded emails and creates Google Calendar events or review blocks. |
| `SMART UNSUBSCRIBE LOGGER.gs` | Finds newsletter/marketing emails, scores them, and logs them to a Google Sheet. |
| `README.md` | Setup and operating instructions for the repo. |

---

## What this repo does

This repo is an experiment in using lightweight personal automations to make Gmail more useful. Instead of manually triaging every email, these scripts use Claude as a classification layer:

- Is this forwarded email a real event, a reservation, a flight, a meeting, or something to review later?
- Is this newsletter actually useful, or is it just inbox noise?

The scripts do **not** replace Gmail, Google Calendar, or Google Sheets. They sit on top of those tools and automate repetitive organization work.

---

## Automation 1: Email → Google Calendar Automation

**File:** `GOOGLE CALENDAR AUTOMATION.gs`

### What it does

This automation watches a designated Gmail address, usually a plus-address such as:

```text
yourname+cal@gmail.com
```

When an email is forwarded to that address, the script:

1. Searches Gmail for unprocessed messages sent to the configured intake address.
2. Reads the subject, send date, and first 6,000 characters of the plain-text email body.
3. Sends that content to Claude with a calendar-extraction prompt.
4. Expects Claude to return structured JSON with one or more items.
5. Creates either:
   - a normal Google Calendar event, or
   - a review block in the next available review window.
6. Marks the Gmail thread as read.
7. Applies a processed Gmail label so the same thread is not handled again.

### Event items

Claude returns an item with `type: "event"` when the email contains a concrete date/time, such as:

- meeting confirmations
- dinner reservations
- concert tickets
- sports tickets
- flights
- hotel or travel bookings
- event schedules

The script creates a Google Calendar event using:

- `title`
- `start`
- `end`
- `location`
- `description`
- `timeZone`, when provided

### Review items

Claude returns an item with `type: "review"` when the email is better treated as something to read, research, or follow up on later.

Examples:

- articles
- documents
- links
- vague tasks
- research topics
- “look into this” emails

The script schedules review blocks inside the configured review window, such as 10:00 AM through 3:00 PM. It searches up to seven days ahead for open space. If no open slot is found, it falls back to the review window start time tomorrow.

### Key configuration values

Inside `GOOGLE CALENDAR AUTOMATION.gs`, update these values:

```js
var TARGET_ADDRESS = 'YOUR_EMAIL_PLUS_ADDRESS_HERE';
var PROCESSED_LABEL = 'cal-processed';
var USER_TIMEZONE = 'YOUR_TIMEZONE_HERE';
var USER_LOCATION_CONTEXT = 'OPTIONAL_LOCATION_CONTEXT_HERE';
var REVIEW_WINDOW_START = 10;
var REVIEW_WINDOW_END = 15;
```

| Variable | Description | Example |
|---|---|---|
| `TARGET_ADDRESS` | Gmail address the script watches for forwarded calendar-related emails. | `yourname+cal@gmail.com` |
| `PROCESSED_LABEL` | Gmail label applied after a thread is processed. | `cal-processed` |
| `USER_TIMEZONE` | Your default timezone in IANA format. | `America/Chicago` |
| `USER_LOCATION_CONTEXT` | Optional location hint for timezone inference. Can be broad. | `Central Time, United States` |
| `REVIEW_WINDOW_START` | Start hour for review blocks, 24-hour time. | `10` |
| `REVIEW_WINDOW_END` | End hour for review blocks, 24-hour time. | `15` |

### Recommended trigger

Create a time-based Apps Script trigger:

```text
Function: processCalendarEmails
Event source: Time-driven
Type: Minutes timer
Interval: Every 10 minutes
```

---

## Automation 2: Smart Unsubscribe Logger

**File:** `SMART UNSUBSCRIBE LOGGER.gs`

### What it does

This automation scans Gmail for newsletter and marketing-style messages, logs each sender to a Google Sheet, and sends a weekly summary email.

On each run, the script:

1. Creates or opens a Google Sheet with the configured name.
2. Creates or finds the configured Gmail processed label.
3. Determines the last run timestamp from the sheet.
4. Searches Gmail for inbox emails that look like newsletters or marketing emails.
5. Reads each candidate sender, subject, date, and first 3,000 characters of the plain-text body.
6. Sends that content to Claude.
7. Asks Claude to classify, score, summarize, and recommend an action.
8. Logs new senders to the Google Sheet.
9. Updates “last seen” date and count for existing senders.
10. Sorts the sheet by lowest value score first.
11. Sends a summary email with the sheet link.

### What gets logged

The generated Google Sheet includes these columns:

| Column | Meaning |
|---|---|
| Sender Name | Display name extracted from the email sender. |
| Sender Email | Sender email address. |
| Category | Claude-generated category, such as Newsletter or Marketing/Promotional. |
| Value Score | 1-10 usefulness score. Lower scores are better unsubscribe candidates. |
| Frequency | Estimated send frequency. |
| What It Sends | Short summary of the sender’s content. |
| Recommendation | Keep, Review, or Unsubscribe. |
| First Seen | First date this sender was logged. |
| Last Seen | Most recent date this sender appeared. |
| Email Count | Number of times this sender has been seen. |
| Unsubscribe Link | URL if visible in the email body. |
| Action Taken | Manual tracking field, defaults to Pending. |

### Key configuration values

Inside `SMART UNSUBSCRIBE LOGGER.gs`, update these values:

```js
var SHEET_NAME = 'YOUR_SHEET_NAME_HERE';
var PROCESSED_LABEL = 'YOUR_PROCESSED_LABEL_HERE';
var USER_TIMEZONE = 'YOUR_TIMEZONE_HERE';
var MAX_THREADS_PER_RUN = 50;
var SEND_SUMMARY_EMAIL = true;
```

| Variable | Description | Example |
|---|---|---|
| `SHEET_NAME` | Name of the Google Sheet to create or reuse. | `Unsubscribe Tracker` |
| `PROCESSED_LABEL` | Gmail label applied after a thread is logged. | `unsubscribe-logged` |
| `USER_TIMEZONE` | Your timezone in IANA format. | `America/Chicago` |
| `MAX_THREADS_PER_RUN` | Max candidate threads to process in a single run. | `50` |
| `SEND_SUMMARY_EMAIL` | Whether to email the logged-in user after each run. | `true` |

### Recommended trigger

Create a weekly time-based Apps Script trigger:

```text
Function: scanForNewsletters
Event source: Time-driven
Type: Week timer
Interval: Weekly
```

You can run it more often, but weekly is usually enough for this use case.

---

## Shared setup steps

Follow these steps for either script.

### 1. Create an Anthropic API key

Create an API key in your Anthropic account. The scripts call the Anthropic Messages API and currently use this model name:

```js
model: 'claude-sonnet-4-5'
```

If Anthropic changes model names or if you prefer another model, update the `model` field inside each script.

### 2. Create a Google Apps Script project

Go to Google Apps Script and create a new project.

For a simple setup, create one Apps Script project per automation:

```text
Project 1: Email to Calendar Automation
Project 2: Smart Unsubscribe Logger
```

This avoids function-name collisions because both scripts include helper functions with the same names, such as:

```js
getAnthropicApiKey()
getOrCreateLabel()
testSetup()
```

You can combine them into one Apps Script project, but you would need to rename duplicate helper functions first.

### 3. Paste the script into Apps Script

For each automation:

1. Open the relevant `.gs` file from this repo.
2. Copy the full script.
3. Paste it into the Apps Script editor.
4. Save the project.

### 4. Add the API key to Script Properties

Do **not** paste the API key directly into the code.

In Apps Script:

```text
Project Settings → Script Properties → Add script property
```

Add:

```text
Property: ANTHROPIC_API_KEY
Value: your Anthropic API key
```

Both automations read the key using:

```js
PropertiesService
  .getScriptProperties()
  .getProperty('ANTHROPIC_API_KEY');
```

### 5. Update placeholders

Replace any placeholder values in the `CONFIGURATION` section of each script.

Common placeholders include:

```text
YOUR_EMAIL_PLUS_ADDRESS_HERE
YOUR_TIMEZONE_HERE
OPTIONAL_LOCATION_CONTEXT_HERE
YOUR_SHEET_NAME_HERE
YOUR_PROCESSED_LABEL_HERE
```

### 6. Run `testSetup()`

Each script includes a `testSetup()` function.

Run it manually from Apps Script before creating a trigger. Google will ask you to authorize the required permissions.

Expected authorizations may include:

- read and modify Gmail labels/messages
- send Gmail email
- read and create Google Calendar events
- create and edit Google Sheets
- access external services through `UrlFetchApp`
- access script properties

The exact permission prompt depends on which script you are setting up.

### 7. Create the trigger

After `testSetup()` succeeds, create the appropriate time-based trigger:

| Automation | Function | Suggested cadence |
|---|---|---|
| Email → Google Calendar Automation | `processCalendarEmails` | Every 10 minutes |
| Smart Unsubscribe Logger | `scanForNewsletters` | Weekly |

In Apps Script:

```text
Triggers → Add Trigger → Choose function → Select time-based schedule
```

---

## Privacy and security notes

These automations process email content and send selected snippets to Anthropic for classification.

### Calendar automation sends Claude:

- email subject
- email sent date
- first 6,000 characters of the plain-text email body
- timezone/location context from your configuration

### Unsubscribe logger sends Claude:

- sender name
- sender email
- subject
- first 3,000 characters of the plain-text email body

Do not use these scripts on inboxes that contain sensitive, regulated, or confidential information unless you are comfortable with that content being sent to Anthropic’s API and have confirmed the relevant privacy, compliance, and retention settings for your account.

Recommended security practices:

- Never hardcode API keys in `.gs` files.
- Store API keys in Apps Script Properties.
- Rotate any API key that has ever been committed, pasted, or shared.
- Use a dedicated Gmail plus-address for the calendar automation.
- Use processed labels to prevent repeated processing.
- Start with small processing limits while testing.
- Review logs after the first few runs.
- Keep this repo free of personal email addresses, API keys, private sheet URLs, and precise personal location details.

---

## Operational notes

### Labels prevent duplicate processing

Both scripts apply a Gmail label after handling a thread. This allows future searches to exclude already-processed messages.

Calendar automation:

```js
-label:cal-processed
```

Unsubscribe logger:

```js
-label:unsubscribe-logged
```

The actual label names depend on your configuration.

### Last-run tracking for unsubscribe scans

The unsubscribe logger writes the last run timestamp into cells `M1` and `N1` of the tracker sheet.

This lets future runs search only for messages after the previous scan.

### Calendar review blocks

The calendar automation schedules review blocks only within the configured review window. It searches up to seven days ahead. If no open slot is available, it schedules the block at the fallback start time tomorrow.

---

## Troubleshooting

### `Missing ANTHROPIC_API_KEY`

The script cannot find your API key in Script Properties.

Fix:

```text
Apps Script → Project Settings → Script Properties
Property: ANTHROPIC_API_KEY
Value: your Anthropic API key
```

### Placeholder error in `testSetup()`

The script still has values like:

```text
YOUR_TIMEZONE_HERE
YOUR_SHEET_NAME_HERE
YOUR_EMAIL_PLUS_ADDRESS_HERE
```

Fix: update the `CONFIGURATION` section before running the automation.

### Anthropic API error

Possible causes:

- invalid API key
- revoked API key
- insufficient credits or billing issue
- model name no longer available
- malformed request payload

Check the Apps Script logs for the exact response.

### No emails found

For the calendar automation, confirm that emails are actually being forwarded to the configured `TARGET_ADDRESS`.

For the unsubscribe logger, confirm that candidate emails match the Gmail search query terms:

```text
unsubscribe
email preferences
manage preferences
opt out
view in browser
email marketing
```

### Duplicate events or rows

Check that the processed Gmail label is being created and applied correctly. If you change the label name after running the script, older processed threads may be picked up again.

### Calendar events have the wrong timezone

Add or improve `USER_LOCATION_CONTEXT`, or update the Claude prompt in the calendar script to provide stronger timezone instructions.

---

## Suggested future improvements

- Add a dry-run mode that logs actions without creating events or sheet rows.
- Add a whitelist/blacklist for newsletter senders.
- Add stronger JSON schema validation before creating events.
- Add duplicate-detection for calendar events.
- Add optional Slack, email, or daily digest notifications.
- Add a shared config file if both automations are eventually combined into one Apps Script project.
- Add clasp support for local development and deployment.

---

## License

No license has been specified yet. Add one before sharing or distributing this repo publicly.
