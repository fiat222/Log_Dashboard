---
id: user-guide
title: User Guide
sidebar_position: 1
slug: /
---

# Log Dashboard — User Guide

Real-time container log viewer and Nginx access log analyzer for PSU EILA.

---

## Sign In

Go to `/logstore/login`. Use your PSU SSO account or a local account provided by your admin.

Your session stays active automatically. To sign out, click **Sign Out** in the sidebar.

---

## Your Role

Your role controls what tabs and data you can access. It shows as a colored badge next to your name in the sidebar.

| Role | Badge color | Access |
|------|-------------|--------|
| **Developer** | Indigo | Logs, Analytics, Patterns — your assigned containers only |
| **Admin** | Red | Everything above + Nginx tab, Admin tab, all containers |
| **Super Admin** | Purple | Everything above + delete users, change roles |

To get a role assigned or changed, contact your Super Admin.

---

## Layout

After signing in, the screen is split into two areas:

- **Sidebar (left)** — your name and role, container list, admin settings
- **Main area (right)** — tab bar at the top, content below

### Tabs at a glance

| Tab | Who sees it | What it does |
|-----|-------------|--------------|
| **Logs** | Everyone | Browse and search container log entries |
| **Analytics** | Everyone | Charts and stats for a selected container |
| **Patterns** | Everyone | Cluster repeated log messages to spot trends |
| **Nginx** | Admin+ | Nginx traffic analytics and access log search |
| **Admin** | Admin+ | User management and system settings |

---

## Sidebar — Containers

The sidebar lists all containers grouped into **stacks**. Click a stack name to collapse or expand it.

Each container shows a colored dot indicating its activity:

| Dot | Meaning |
|-----|---------|
| 🟢 Green | Active — logged in the last 60 s |
| 🟠 Orange | Recent — logged in the last 5 min |
| ⚪ Gray | Idle or stopped |

Click a container name to load its logs.

:::note Developer accounts
You only see containers assigned to your account.
:::

Admins can create a new stack by clicking **+** at the top of the sidebar.

---

## Logs Tab

### Reading the table

| Column | Description |
|--------|-------------|
| Timestamp | Date and time of the log entry |
| Level | ERROR · WARN · INFO · DEBUG |
| Message | Full log text |
| Container | Source container name |

Rows are color-coded: red (ERROR), amber (WARN), blue (INFO), gray (DEBUG).

Click any row to expand the full message.

### Filtering

| Control | What it does |
|---------|-------------|
| Search box | Free-text match inside log messages |
| Level | Show only one severity level |
| From / To | Date and time range (pick date + HH/MM) |
| **Apply** | Run the filter |
| **Reset** | Clear all filters |

Press `Enter` in the search box to apply without clicking Apply.

### Live stream

Click **↻ Live** to stream new logs in real time as they arrive. Click again to stop.

### Export

Click **Export** to download the filtered logs as a `.jsv` file. All active filters apply to the export.

---

## Analytics Tab

Charts and statistics for the selected container over a chosen time range.

| Widget | Shows |
|--------|-------|
| Log volume over time | Log count per hour |
| Level breakdown | ERROR / WARN / INFO / DEBUG share |
| Error rate | % of error logs |
| Top error messages | Most repeated error strings |

Use the **time range** selector (top-right) to switch between 1 h, 24 h, 7 d, or a custom range.

---

## Patterns Tab

Patterns groups similar log messages together so you can see which messages repeat most often.

1. Optionally select a container in the sidebar first to scope results.
2. Choose a time window — **Last 1 hour** or **Last 24 hours**.
3. Click **Load Patterns**.

| Column | Description |
|--------|-------------|
| Count | How many times this pattern appeared |
| Severity | Dominant log level for this pattern |
| Pattern | Normalized message — `?` marks replace variable parts |
| First Seen | Earliest occurrence in the window |
| Last Seen | Most recent occurrence |

Click any pattern row to jump to the **Logs** tab with that pattern pre-filled in the search box.

---

## Nginx Tab *(Admin and above)*

### Overview cards

| Card | Shows |
|------|-------|
| Total Requests | All HTTP requests in the period |
| Error Rate (5xx) | % of server error responses |
| Total Bytes | Bytes sent to clients |

Use the time selector at the top to switch between 5 min, 30 min, 1 h, 6 h, 24 h, 2 d, or 7 d.

### Charts

- **Traffic over time** — requests per minute, stacked by status code family (2xx / 3xx / 4xx / 5xx)
- **Top Client IPs** — most active IP addresses
- **Top Paths** — most-requested URLs with error breakdown by website

### Log search

A searchable table of raw Nginx access log entries.

**Columns:** IP · Time · Method · Website · Path · Status · Bytes · Response time

**Filters:** path substring · status code · HTTP method · date range · sort order

Click **Apply** to filter, **Reset** to clear, **↻ Refresh** to reload. Use **← Prev / Next →** to page through results (50 rows per page).

---

## Admin Tab *(Admin and above)*

### Users

View all registered accounts.

| Action | Who can do it |
|--------|---------------|
| Create local user | Admin, Super Admin |
| Change role | Super Admin only |
| Delete user | Super Admin only |

### Settings *(sidebar, bottom)*

| Setting | Default | Effect |
|---------|---------|--------|
| Log retention | 90 days | How long logs are kept before automatic deletion |
| Active threshold | 60 s | Seconds without a log before dot turns orange |
| Recent threshold | 300 s | Seconds without a log before dot turns gray |
| Dot colors | — | Color pickers for active / recent status indicators |

Click **Save** next to each setting to apply it immediately.

---

## Notifications

The 🔔 bell icon (top-right) shows system alerts generated automatically.

| Alert | Triggered when |
|-------|---------------|
| Critical log | An ERROR-level event is detected in a container's logs |
| Log spam | A container emits abnormally high log volume within one minute |
| Container down | A container stops logging for more than 5 minutes and is confirmed stopped |
| Container recovered | A previously-down container resumes logging |

Click the bell to open the panel. Click **Mark all read** to clear the badge.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Apply filter (when search box is focused) |
| `Escape` | Close modal or dropdown |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Log table is empty | Widen the date range, or check that the container is running |
| Nginx tab not visible | Your role is Developer — ask an Admin to promote you |
| Live stream stops | Toggle **↻ Live** off then back on |
| No data in Analytics | Select a container in the sidebar first, then choose a time range |
| Notification bell stuck | Open the panel and click **Mark all read** |
| Patterns table empty | Try a wider time window, or check that logs exist for the container |
