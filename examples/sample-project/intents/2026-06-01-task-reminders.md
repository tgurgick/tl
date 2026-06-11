---
title: "Task reminders"
created: 2026-06-01
project: "todo-app"
status: "decomposed"
priority: "p1"
tags: [notifications, retention]
specs:
  - "specs/reminder-scheduling/"
---

# Task reminders

## Outcome

Users can attach a due date to any task and get a notification when it's due. A task with a reminder never silently slips past its deadline — the user either acts on the notification or snoozes it.

## Why this matters

Beta testers report forgetting tasks they entered days ago. The app currently only helps people who reopen it on their own. Reminders close the loop: capture → forget → get reminded → act. Without them, todo-app is a write-only list.

## Success metrics

| Metric | Target | How measured |
|--------|--------|-------------|
| Tasks with due dates | > 40% of new tasks | analytics event on task create |
| Reminder → app open | > 25% tap-through | notification open rate |

## Scope

### In

- Due date picker on task create/edit
- Local notification at the due time
- Snooze (15 min / 1 hr / tomorrow)

### Out

- Recurring reminders
- Location-based reminders
- Push (server-sent) notifications

## Constraints

- Local notifications only — no backend exists yet
- Must work with the app force-quit

## Approach

One spec for scheduling/firing notifications, a follow-up spec for snooze actions once the first lands.
