# WorkAxle to Calendar Sync

A Chrome/Brave extension (Manifest V3) that syncs ICC WorkAxle roster shifts to **Google Calendar** and **Apple Calendar** (or any iCal-compatible app).

## What's New in v2

- **Account switcher** — see which Google account is active, sign out and switch with one click
- **Apple Calendar support** — live iCal feed via Cloudflare Worker (free), or manual .ics download
- **Fixed bugs** — calendar ID handling, double script injection, redundant API calls
- **Company ID auto-detection** — extracted from URLs, no longer hardcoded
- **Brave browser** — works out of the box (Chromium-based, no changes needed)

---

## Prerequisites

- Google Chrome or Brave browser
- A Google account with Calendar access
- Access to WorkAxle ICC (`https://icc.workaxle.com/`)

---

## Extension Setup

### Step 1: Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Navigate to **APIs & Services > Library** → enable **Google Calendar API**

### Step 2: OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**
2. Select **External**, fill in app name ("WorkAxle Sync") and contact emails
3. Add scopes: `calendar.events`, `calendar.readonly`, `userinfo.email`, `userinfo.profile`
4. Add your Google account as a test user

### Step 3: Create OAuth Client ID

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Chrome extension**
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`)

### Step 4: Update manifest.json

Replace the `client_id` in `manifest.json` with your own:

```json
"oauth2": {
  "client_id": "your-client-id.apps.googleusercontent.com",
  ...
}
```

### Step 5: Load the Extension

**Chrome:**
1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

**Brave:**
1. Go to `brave://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

### Step 6: First Use

1. Open `https://icc.workaxle.com/` and log in
2. Refresh the WorkAxle schedule page (this lets the extension capture your auth tokens)
3. Click the extension icon
4. The token status should turn green — if not, refresh WorkAxle again
5. Select a Google Calendar and click **Sync Next 4 Weeks**

---

## Apple Calendar (Live iCal Feed)

For a live, auto-updating feed that works with Apple Calendar, Outlook, or any iCal app:

### Deploy the Cloudflare Worker (free, no server needed)

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **Workers & Pages → Create Worker**
3. Click **Edit code** and paste the entire contents of `cloudflare-worker.js`
4. Click **Deploy**

### Add your WorkAxle tokens as secrets

1. In your Worker, go to **Settings → Variables → Secrets**
2. Add these secrets:

| Secret name | Value |
|---|---|
| `WORKAXLE_AUTH_TOKEN` | Your Authorization header value |
| `WORKAXLE_CLUSTER_ID` | Your Cluster-Id header value |
| `WORKAXLE_COMPANY_ID` | Your company ID (usually `1`) |
| `FEED_SECRET` | Any random string, e.g. `mysecret123` |

**How to find your token values:**
- Open WorkAxle in Chrome/Brave with the extension installed
- Open DevTools → Application → Session Storage → `https://icc.workaxle.com`
- Copy `workaxleAuthToken`, `workaxleClusterId`, `workaxleCompanyId`

### Get your feed URL

Your feed URL will be:
```
https://your-worker-name.your-subdomain.workers.dev/?secret=mysecret123
```

### Add the URL to the extension

Open `popup.js` and set:
```js
const CLOUDFLARE_WORKER_URL = 'https://your-worker-name.your-subdomain.workers.dev/?secret=mysecret123';
```

Then reload the extension.

### Subscribe in Apple Calendar

1. Copy the feed URL from the **Apple Calendar** tab in the extension popup
2. Open Calendar → **File → New Calendar Subscription**
3. Paste the URL → click **Subscribe**
4. Set **Auto-refresh: Every Hour**

### Subscribe in Outlook

1. Go to **Outlook Calendar → Add calendar → Subscribe from web**
2. Paste the feed URL

### Token expiry

WorkAxle tokens expire periodically. When the feed stops working:
1. Open WorkAxle and refresh the schedule page
2. Get fresh token values from DevTools → Session Storage
3. Update the secrets in your Cloudflare Worker

---

## Manual iCal Export (.ics file)

If you don't want to set up a Cloudflare Worker, you can export a one-time .ics file:

1. Open the extension popup → **Apple Calendar** tab
2. Click **Download .ics File**
3. Import the file into Apple Calendar, Outlook, Google Calendar, etc.

Note: This is a snapshot and won't auto-update. You'll need to re-export and re-import when your roster changes.

---

## Switching Google Accounts

1. Click the extension icon
2. At the top, click **Switch** next to your current email
3. Click **Sign in** to authenticate with a different Google account
4. The calendar list will reload with the new account's calendars

---

## How It Works

1. **Token capture** — The extension injects a script that intercepts WorkAxle's API calls to capture your auth headers. These are stored in Chrome's session storage (cleared when you close the browser).
2. **Shift fetching** — Uses captured tokens to call WorkAxle's REST + GraphQL APIs for the next 4 weeks of shifts.
3. **Google Calendar sync** — Creates/updates/deletes events using stable IDs (`workaxle<shift_id>`) to avoid duplicates. Only manages events it created (tagged with `source=workaxle`).
4. **iCal feed** — The Cloudflare Worker serves a live `.ics` file using tokens you've stored as secrets. Calendar apps poll this URL automatically.

---

## Permissions

| Permission | Why |
|---|---|
| `identity` | Google OAuth authentication |
| `storage` | Token storage (session only, not permanent) |
| `scripting` | Inject token-capture script |
| `activeTab` | Access current tab |

## Host Permissions

| Host | Why |
|---|---|
| `https://icc.workaxle.com/*` | WorkAxle webapp |
| `https://api.app.workaxle.com/*` | WorkAxle API |
| `https://www.googleapis.com/*` | Google Calendar API |
| `https://accounts.google.com/*` | Google OAuth sign-out |

---

## File Structure

```
workaxle-sync/
├── manifest.json          # Extension manifest (MV3)
├── service_worker.js      # Core extension logic
├── content.js             # Content script (message bridge)
├── inject.js              # Main-world script (token capture)
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic
├── popup.css              # Popup styles
├── cloudflare-worker.js   # Cloudflare Worker for live iCal feed
├── icons/
│   └── icon.svg
└── README.md
```

## License

MIT
