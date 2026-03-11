# Court Scout — Setup Guide

## What you need
- A free GitHub account (github.com)
- A free Render account (render.com)

---

## Step 1 — Put the files on GitHub

1. Go to **github.com** and sign in (or create a free account)
2. Click the **+** button (top right) → **New repository**
3. Name it `court-scout`, leave everything else as default, click **Create repository**
4. On the next page, click **uploading an existing file**
5. Drag and drop **both files** (`server.js` and `package.json`) into the upload area
6. Click **Commit changes**

---

## Step 2 — Deploy on Render

1. Go to **render.com** and sign in with your GitHub account
2. Click **New +** → **Web Service**
3. Click **Connect** next to your `court-scout` repository
4. Fill in the settings:
   - **Name:** court-scout (or anything you like)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Click **Create Web Service**
6. Wait about 2 minutes for it to deploy — you'll see a green **Live** badge
7. Click the URL at the top (looks like `https://court-scout-xxxx.onrender.com`) — that's your Court Scout dashboard!

---

## Step 3 — Configure Court Scout

Open your Render URL on any device (phone or computer):

1. **Monitor tab:** Paste your ClubSpark booking page URL
2. **Courts tab:** Add the court names/numbers you want (e.g. `Court 1`, `Centre Court`) — or leave empty for any court
3. **Alerts tab:** Enter your ntfy topic name and hit Test
4. Hit **Save & Start Watching** — it runs 24/7 on Render's servers!

---

## Notes

- The free Render tier keeps your app alive as long as it gets traffic (Court Scout pings itself every 14 minutes to stay awake)
- If Render does put it to sleep, it wakes up automatically on the next scheduled check
- You can open the dashboard URL on your phone to check status anytime
