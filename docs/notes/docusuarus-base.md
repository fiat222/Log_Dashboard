---
title: Log Dashboard — User Guide
sidebar_label: User Guide
---

# Log Dashboard — User Guide

**Prince of Songkla University · EILA**  
Real-time Docker container log viewer and Nginx access log analyzer.

---

## Overview

Log Dashboard centralizes logs from all Docker containers and Nginx reverse proxies into a single web interface. It supports live streaming, historical search, analytics charts, and role-based access control.

---

## Logging In

Navigate to the dashboard URL in your browser. You will see the login page with two options:

### PSU Passport (SSO)

Click **Sign in with PSU Passport**. You will be redirected to the university single sign-on portal. After authenticating, you are returned to the dashboard automatically.

### Username / Password

For admin accounts not linked to PSU Passport:

1. Enter your **Username** in the first field.
2. Enter your **Password** in the second field.
3. Click **เข้าสู่ระบบ** (Login).
4. Use the **show / hide** toggle to reveal your password if needed.

If credentials are incorrect, an error message appears in Thai and English below the form.

---

## Dashboard Layout

After login the interface is split into two areas:

| Area | Description |
|------|-------------|
| **Sidebar (left)** | User info, role badge, stack/container list, admin settings |
| **Main area (right)** | Tab bar at the top, content below |

### Tab Bar

| Tab | Who can see it | Description |
|-----|---------------|-------------|
| 📄 **Logs** | All users | Container log viewer |
| 📊 **Analytics** | All users | Per-container charts and statistics |
| 🛡 **Admin** | Admin, Super Admin | User management, system config |
| 🌐 **Nginx** | Admin, Super Admin | Nginx access log viewer and analytics |

---

## Sidebar — Stacks & Containers

The sidebar lists all **stacks** (groups of Docker containers). Each stack is collapsible.

- **Colored dot** next to each container name indicates activity:
  - 🟢 **Green** — container logged within the last 60 seconds (active)
  - 🟠 **Orange** — logged within the last 5 minutes (recent)
  - ⚪ **Gray** — no recent logs (idle or stopped)

Click a container name to load its logs in the main view.

Click **+** (top of sidebar) to create a new stack (Admin / Super Admin only).

---

## Logs Tab

### Viewing Logs

Select a container from the sidebar. Logs appear in a table with these columns:

| Column | Description |
|--------|-------------|
| **Timestamp** | Date and time of the log entry |
| **Level** | Severity — ERROR, WARN, INFO, DEBUG |
| **Message** | Full log message |
| **Container** | Source container name |

Rows are color-coded by level: red (ERROR), amber (WARN), blue (INFO), gray (DEBUG).

### Filtering

Use the filter bar above the log table:

- **Search** — Free-text search within log messages.
- **Level** — Filter by severity (Error / Warn / Info / Debug).
- **Date From / To** — Select a date and time range using the date picker and hour/minute dropdowns.
- **Apply** — Execute the current filter.
- **Reset** — Clear all filters and return to defaults.

### Live Stream

Click **↻ Live** (or the live toggle) to enable real-time log streaming via Server-Sent Events (SSE). New logs appear at the top of the table as they arrive. Click again to pause.

### Export

Click **Export** to download the current filtered log set as a CSV file. The export respects all active filters (container, level, date range).

---

## Analytics Tab

Shows per-container statistics for the selected time range:

- **Log volume over time** — Line chart of log count per minute/hour.
- **Level distribution** — Pie or bar chart showing ERROR / WARN / INFO / DEBUG breakdown.
- **Error rate** — Percentage of error logs relative to total.
- **Top error messages** — Most frequent error strings.

Use the **time range selector** at the top to switch between Last 1 h, Last 24 h, Last 7 d, and custom ranges.

---

## Nginx Tab *(Admin / Super Admin only)*

The Nginx tab is split into two sections: **Analytics** (overview metrics and charts) and **Logs** (searchable access log table).

### Analytics Section

**Time range selector** at the top controls all analytics widgets:

| Option | Description |
|--------|-------------|
| Last 1 h | Past 1 hour |
| Last 6 h | Past 6 hours |
| Last 24 h | Past 24 hours (default) |
| Last 2 d | Past 48 hours |
| Last 7 d | Past 7 days |

**Metric cards:**

| Metric | Description |
|--------|-------------|
| Total Requests | All HTTP requests in the selected period |
| Error Rate (5xx) | Percentage of server error responses |
| Total Bytes | Sum of bytes sent to clients |

**Traffic chart** — Stacked area chart of requests per minute grouped by HTTP status code family (2xx, 3xx, 4xx, 5xx).

**Top Client IPs** — List of IP addresses making the most requests.

**Top Paths table** — Most-requested URL paths with request count and error count, grouped by website (virtual host).

### Logs Section

A full-text searchable table of raw Nginx access log entries.

**Columns:**

| Column | Description |
|--------|-------------|
| Client IP | Remote client address |
| Timestamp | Date and time of the request |
| Method | HTTP method (GET, POST, …) |
| Website | Virtual host / referer domain |
| Path | Request URI |
| Status | HTTP response status code |
| Bytes | Response size in bytes |
| Time | Request processing time in seconds |

**Filter bar options:**

| Filter | Description |
|--------|-------------|
| Search path | Filter by URL path substring |
| Status code | Filter by exact HTTP status (200, 400, 404, 500, …) |
| Method | Filter by HTTP method |
| Sort | Newest first / Oldest first |
| From / To | Custom date and time range (date picker + hour + minute) |

Click **Apply** to run the filter. Click **Reset** to clear. Click **↻ Refresh** to reload with current filters.

**Pagination** — Use **← Prev** and **Next →** to page through results (50 rows per page by default).

---

## Admin Tab *(Admin / Super Admin only)*

### User Management

View all registered users. Columns: Username, Role, Created At.

- **Create user** — Add a new local account with a username, password, and role.
- **Delete user** — Remove a non-SSO account (Super Admin only).
- **Change role** — Promote or demote a user's role (Super Admin only).

### Settings (Sidebar)

Admins see a ⚙️ Settings section at the bottom of the sidebar:

| Setting | Description |
|---------|-------------|
| Log Retention (days) | How long ClickHouse keeps logs before auto-deletion (default 90 days) |
| Active threshold (sec) | Seconds since last log for a container to show green dot (default 60) |
| Recent threshold (sec) | Seconds since last log for a container to show orange dot (default 300) |
| Active Color | Color picker for the active (green) dot |

Click **Save** next to each setting to apply immediately.

---

## User Roles

| Role | Badge color | Capabilities |
|------|------------|--------------|
| **Developer** | Indigo | View Logs tab, Analytics tab |
| **Admin** | Red | All above + Nginx tab, Admin tab, user management |
| **Super Admin** | Purple | All above + delete users, change roles, raw SQL exec |

Your role is shown as a pill badge in the top of the sidebar beside your username.

---

## Notifications

A 🔔 bell icon in the top-right of the header bar shows system alerts:

- **Critical log alerts** — Triggered when ERROR-level messages exceed a threshold.
- **Spam anomaly alerts** — Triggered when a container produces unusually high log volume within one minute.
- **Container downtime alerts** — Triggered when a previously active container stops logging for over one hour.

Click the bell to open the notification dropdown. Unread alerts are highlighted. Click an alert to dismiss it.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` (in search box) | Apply current filter |
| `Escape` | Close modals and dropdowns |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Blank log table after selecting container | No logs in selected time range | Expand date range or check container is running |
| "Unauthorized" on Nginx tab | Insufficient role | Request Admin role from Super Admin |
| Live stream stops updating | SSE connection dropped | Click the live toggle off and on again |
| Login redirects back to login | Session cookie expired | Log in again |
| Nginx metrics show — | Nginx not sending logs to ClickHouse | Check Vector/Fluent Bit pipeline on the server |
