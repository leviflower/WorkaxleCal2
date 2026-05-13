# WorkAxle to Calendar Sync

A Chrome/Brave extension (Manifest V3) that syncs ICC WorkAxle roster shifts to **Google Calendar** and **Apple Calendar** (or any iCal-compatible app).

## Features

- Automatically captures WorkAxle auth tokens from your logged-in session
- Syncs shifts for the next 4 weeks to Google Calendar
- Live iCal feed via Cloudflare Worker for Apple Calendar (always on, no computer needed)
- Auto-pushes fresh tokens to Cloudflare whenever you open WorkAxle
- Account switcher — sign in/out of Google without reopening the browser
- Auto-syncs Google Calendar every hour in the background
- One-click Open Schedule button
- Works on Chrome and Brave

---

## Prerequisites

- Google Chrome or Brave browser
- A Google account with Calendar access
- Access to WorkAxle ICC (`https://icc.workaxle.com/`)

---

## Extension Setup

### Step 1 — Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Go to **APIs & Services → Library** → enable **Google Calendar API**

### Step 2 — OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External**
3. Fill in app name ("WorkAxle Sync") and contact email
4. Add scopes: `calendar.events`, `calendar.readonly`, `userinfo.email`, `userinfo.profile`
5. Add your Google account as a test user
6. Click **Save and Continue**

> Once ready for others to use, go back and click **Publish App** to remove the test user restriction.

### Step 3 — Create OAuth Client ID

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name it "WorkAxle Sync"
5. Under **Authorised redirect URIs** add:
   ```
   https://YOUR-EXTENSION-ID.chromiumapp.org/
   ```
   Replace `YOUR-EXTENSION-ID` with your actual extension ID (found at `brave://extensions/` or `chrome://extensions/` after loading the extension)
6. Click **Create** and copy the **Client ID**

> **Note:** Each computer/browser install gets a different extension ID. If you install on a second computer, add a second redirect URI with that computer's extension ID — you can have multiple on the same OAuth client.

### Step 4 — Update manifest.json and service_worker.js

Replace the `client_id` value in `manifest.json`:

```json
"oauth2": {
  "client_id": "YOUR-CLIENT-ID.apps.googleusercontent.com",
  ...
}
```

Also update the same value near the top of `service_worker.js`:

```js
const OAUTH_CLIENT_ID = 'YOUR-CLIENT-ID.apps.googleusercontent.com';
```

### Step 5 — Load the Extension

**Chrome:**
1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

**Brave:**
1. Go to `brave://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

Note your **Extension ID** shown under the extension name — you need it for the redirect URI in Step 3.

### Step 6 — First Use

1. Open `https://icc.workaxle.com/` and log in
2. Refresh the WorkAxle schedule page — the extension captures your auth tokens automatically
3. Click the extension icon — the token status dot should turn green
4. Click **Sign in** to connect your Google account
5. Select a Google Calendar and click **Sync Next 4 Weeks**

---

## Apple Calendar — Live iCal Feed

For a live always-on feed that works with Apple Calendar, Outlook, or any iCal-compatible app. No computer needs to be left on.

### Step 1 — Deploy the Cloudflare Worker

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **Workers & Pages → Create → Start with Hello World**
3. Click **Edit code**, delete everything, paste the contents of `cloudflare-worker.js`
4. Click **Deploy**

### Step 2 — Create a KV Namespace

1. In Cloudflare go to **Storage & databases → KV**
2. Click **Create namespace**, name it `TOKENS`, click **Add**
3. Go back to your Worker → **Bindings** tab → **Add**
4. Variable name: `TOKENS`, select the namespace you just created
5. Click **Save**

### Step 3 — Add Secrets

Go to your Worker → **Settings → Variables and Secrets** → add each as type **Secret**:

| Secret name | Value |
|---|---|
| `FEED_SECRET` | Any password you choose, e.g. `mypassword123` |
| `WORKAXLE_AUTH_TOKEN` | Your WorkAxle auth token (see below) |
| `WORKAXLE_CLUSTER_ID` | Your WorkAxle cluster ID (see below) |
| `WORKAXLE_COMPANY_ID` | `1` |

**To find your token values:**
1. Open WorkAxle in Brave with the extension installed and refresh the page
2. Press F12 → **Application** → **Extension Storage** → **WorkAxle to Calendar** → **Session**
3. Copy `workaxleAuthToken` and `workaxleClusterId`

### Step 4 — Connect the Extension to Your Worker

1. Open the extension popup → **Apple Calendar** tab
2. Enter your Worker base URL (e.g. `https://your-worker.workers.dev`)
3. Enter your `FEED_SECRET` password
4. Click **✓** to save

From now on, every time you open WorkAxle in Brave the extension will automatically push fresh tokens to your Worker — no manual updates needed.

You can also click **Push Tokens to Worker Now** to trigger it manually.

### Step 5 — Subscribe in Apple Calendar (iPhone/iPad)

1. Open **Settings → Calendar → Accounts → Add Account → Other**
2. Tap **Add Subscribed Calendar**
3. Enter your feed URL:
   ```
   https://your-worker.workers.dev/?secret=mypassword123
   ```
4. Tap **Next → Save**

Your shifts will appear in Apple Calendar and auto-refresh every hour.

### Subscribe in Outlook

1. Go to **Outlook Calendar → Add calendar → Subscribe from web**
2. Paste your feed URL

---

## Apple Calendar via Google (Easiest Option)

If you already sync to Google Calendar, the simplest way to get shifts on your iPhone is:

1. On your iPhone open **Settings → Calendar → Accounts → Add Account**
2. Tap **Google** and sign in with the same account used in the extension
3. Make sure **Calendars** is toggled on
4. Open the **Calendar** app — shifts appear within minutes and stay in sync automatically

---

## Switching Google Accounts

1. Click the extension icon
2. At the top click **Switch** next to your current email
3. Click **Sign in** to authenticate with a different account
4. The calendar list reloads with the new account's calendars

---

## Auto-Sync

The extension automatically syncs to Google Calendar every hour in the background while Brave is open. The last sync time is shown in the popup.

---

## How It Works

1. **Token capture** — When you load WorkAxle, an injected script intercepts API calls and captures the `Authorization` and `Cluster-Id` headers from your authenticated session
2. **Token push** — Fresh tokens are automatically pushed to your Cloudflare Worker so the iCal feed stays current
3. **Shift fetching** — Uses captured tokens to call WorkAxle's REST and GraphQL APIs for the next 4 weeks
4. **Google Calendar sync** — Creates/updates/deletes events using stable IDs to avoid duplicates. Only manages events it created (tagged `source=workaxle`)
5. **iCal feed** — The Cloudflare Worker serves a live `.ics` file using the latest tokens stored in KV. Calendar apps poll this URL automatically

---

## Permissions

| Permission | Why |
|---|---|
| `identity` | Google OAuth authentication |
| `storage` | Token storage |
| `scripting` | Inject token-capture script |
| `activeTab` | Access current tab |
| `alarms` | Background auto-sync every hour |
| `tabs` | Open WorkAxle schedule tab |

## Host Permissions

| Host | Why |
|---|---|
| `https://icc.workaxle.com/*` | WorkAxle webapp |
| `https://api.app.workaxle.com/*` | WorkAxle API |
| `https://www.googleapis.com/*` | Google Calendar API |
| `https://accounts.google.com/*` | Google OAuth |

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

---

## Troubleshooting

**Token status is orange / "No tokens"**
Refresh the WorkAxle schedule page in Brave. The extension captures tokens automatically on page load.

**redirect_uri_mismatch error when signing in**
Your extension ID needs to be registered in Google Cloud. Go to Credentials → your OAuth client → add `https://YOUR-EXTENSION-ID.chromiumapp.org/` to Authorised redirect URIs.

**iCal feed shows "token expired"**
Open WorkAxle in Brave and refresh the page — tokens will be pushed to Cloudflare automatically. Or click **Push Tokens to Worker Now** in the popup.

**Shifts not appearing in Apple Calendar**
Check your feed URL works by opening it in a browser — you should see text starting with `BEGIN:VCALENDAR`. If you see a token expired error, see above.

---

## License

MIT
