---
title: "Schedule local notifications for task due dates"
created: 2026-06-03
project: "todo-app"
repo: "~/code/todo-app"
intent: "intents/2026-06-01-task-reminders.md"
type: "feature"
status: "ready"
priority: "p1"
priority_set_by: "triage"
size: "medium"
depends_on: []
blocks: []
tags: [notifications]
---

# Schedule local notifications for task due dates

## Objective

When a task has a due date, a local notification fires at that time with the task title; completing or deleting the task cancels it.

## Context

Tasks live in `TaskStore` (see `repo:ARCHITECTURE.md`, Persistence section). There is no notification code yet — this spec introduces it. Notification permission should be requested lazily, the first time a user sets a due date, not at app launch.

## Acceptance criteria

- [ ] Setting a due date schedules a notification; `npm test -- reminder` passes
- [ ] Completing or deleting the task cancels its pending notification
- [ ] Permission denied → task still saves, a non-blocking banner explains reminders are off
- [ ] Update `ARCHITECTURE.md` with the new Notifications section

## Scope

### Files to touch

- `src/notifications/reminderScheduler.ts` — new; schedule/cancel logic
- `src/store/TaskStore.ts` — call scheduler on create/update/complete/delete
- `src/screens/TaskEdit.tsx` — due date picker wiring

### Do not touch

- `src/sync/` — server sync is out of scope for v1

## Hints

Use one notification identifier per task id so cancellation is idempotent. Watch for the timezone edge case: store due dates as UTC, schedule in local time.
