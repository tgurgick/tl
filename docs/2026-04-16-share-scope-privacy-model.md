---
title: "Share Scope: Task-Level vs Home-Level Privacy Model"
created: 2026-04-16
project: "checksout"
origin: "privacy-law-research"
status: "ready-to-converge"
tags: [privacy, sharing, gdpr, data-model, architecture-decision]
explored:
  - "GDPR/CCPA/TCPA implications for peer-to-peer sharing"
  - "Venmo FTC settlement precedent for default sharing"
  - "SMS vs push notification legal distinctions"
  - "Task-level vs home-level scope separation"
unexplored:
  - "UX for upgrading from task-share to home membership"
  - "Data retention policy for task-share recipients after resolution"
---

# Share Scope: Task-Level vs Home-Level Privacy Model

## The problem

ChecksOut's share mechanic enriches tasks with AI-generated home context (appliance models, maintenance history, expense amounts). Sharing a task was originally designed as a gateway into the home — recipients resolve tasks in the action space, and resolutions generate home knowledge. Over time, a task-share recipient accumulates a detailed profile of the home without ever being invited as a member.

This creates three legal/privacy risks:

1. **Cumulative exposure.** Each share is low-risk, but 50 shares assemble a full home profile — spending, appliances, maintenance patterns — without the recipient ever receiving explicit home access.
2. **Cross-user data leakage.** In multi-user homes, Alice sharing a task may inadvertently expose data Bob contributed (his expenses, his maintenance calls) to a recipient Bob doesn't know.
3. **Regulatory.** Home + appliance + expense data is personal data under GDPR and CCPA. Auto-enriching shares with home knowledge creates data minimization concerns (GDPR Art. 5(1)(c)) and notice issues (CCPA). The Venmo/FTC settlement directly penalized defaulting to broad sharing without adequate disclosure.

## The decision

**Separate task-level sharing from home-level membership.** These are two distinct actions with different privacy scopes.

### Task share

A sealed envelope. The recipient gets one task with the context the sender approved. They can act on it (buy the item, call the provider, troubleshoot). When done, the resolution data flows back to the sender's home. The recipient never sees the home knowledge base, other items, maintenance history, or expense data beyond what's in this specific task.

- Sender previews enriched content before sharing
- Enrichment is scoped to this task's context only, not the home graph
- Recipient access expires when the task is resolved or explicitly closed
- No home knowledge accumulates on the recipient's side

### Home invite

An explicit, separate action. "Join this home" gives full shared visibility: all items, history, health score, everything. Requires both parties to agree. This is for actual household members who need ongoing access.

- Requires explicit invitation and acceptance
- Full bidirectional visibility of home data
- Governed by `home_members` table with role (owner/member)

## Data flow on task resolution

When a task-share recipient resolves a task (e.g., pays the plumber, buys the filter):

- Resolution data (expense, completion, notes) flows to the home
- The sender sees it as part of their home knowledge
- The recipient does not retain access to the data after resolution
- The recipient's own home (if they have one) is unaffected

## Data model changes

Existing schema supports this with minimal changes:

```sql
-- Add scope to shares table
ALTER TABLE shares ADD COLUMN scope TEXT DEFAULT 'task';
-- scope: 'task' (sealed envelope) | 'home' (full membership invitation)

-- Task-share recipients see only explicitly shared items
-- Home members see everything via home_members join
```

Query pattern: when loading items for a user, check `home_members` first (full access). If not a member, check `shares` table for task-level shares (scoped access to specific items only).

## Trust ladder

The share mechanic becomes a graduated trust model:

1. **Receive a task** — zero commitment, just a push notification
2. **Resolve it** — engage with the action space, see one task's context
3. **Share one back** — bidirectional value, still task-scoped
4. **Join the home** — explicit upgrade to full household membership

This maps to the growth funnel: task shares drive acquisition (low friction, low privacy risk), home invites drive retention (high trust, high value).

## Channel rules

Based on privacy law research (TCPA, ePrivacy, GDPR):

- **SMS:** Bare notification only — "Trevor shared a task with you. Tap to view: [deep link]." No AI-enriched content, no expense data, no appliance details. This avoids TCPA promotional classification.
- **Push notification (in-app):** Can carry richer context since users opted in by installing. Still subject to sender preview.
- **In-app action space:** Full enriched context available after the recipient taps in.

## Open edges

- **What if a task-share recipient needs to see related items?** (e.g., "buy furnace filters" benefits from knowing the filter size, which is a separate item.) Options: sender can attach related context manually, or the AI includes relevant specs in the task enrichment at share time.
- **Notification content for push.** Even within the app, the sender should preview what the push notification will say. Default to task title + sender name. Enriched details appear only after tapping in.
- **Data retention.** After a task-share recipient resolves and the task closes, do we delete their access record or keep it for audit? Recommendation: keep the share record, revoke access to task content.
