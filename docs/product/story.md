# Wherefore: the main story (draft 0, 2026-10-04)

## The problem

People keep tabs open because each tab stands in for something they meant to do: finish, follow, decide, read, come back to. Closing a tab feels like forgetting that intention, so tabs pile up: 100+ tabs across many windows, the browser slows down, and the real to-do list is buried in tab titles nobody can read.

Bookmarks, tab managers and "close all" don't help, because they save tabs and drop the *reason*. The POC showed the reason can be recovered: given the open tabs, a model reconstructs the intentions accurately. It even caught a forgotten "cancel the Meshy subscription".

## The promise

**Close every tab without losing what it was for.**

## Who it's for

- **v1: knowledge workers who live in the browser and drown in tabs.** The first users are engineers and PMs (co-workers already asking for it): GitHub PRs, docs, dashboards, research, shopping, all mixed together across windows.
- **Later:** anyone with tab overload. That means no assumption of a terminal, an API key or a coding agent.

## The main story

> Dana has 140 tabs in 6 windows. Chrome is slow, and she can't find the PR she was reviewing.
>
> She opens Wherefore and clicks **Tidy up**. Within a minute the first intentions stream in: *"Finish reviewing the auth PR"* (4 tabs), *"Decide between two standing desks"* (9 tabs), *"Follow the Vite 8 release"* (2 tabs). It already knows 31 tabs are safe to close: merged PRs, finished orders, login pages, duplicates. It asks her two short questions about tabs it couldn't place, with clickable answers.
>
> She skims the cards, fixes one task's wording, and clicks **Save 9 and close 127**. 127 tabs close. Her to-dos are in her list, each with its tabs tucked inside.
>
> Next morning she opens **Your list**, clicks *"Finish reviewing the auth PR"*, and its 4 tabs come back as a tab group. She finishes, clicks **Done**, the group closes, and the item moves to her Done archive.
>
> A week later she has 60 tabs again. This time Tidy up takes 20 seconds. It recognizes the 15 tabs that belong to things she already saved and only thinks about the new ones.

## The core loop

1. **Triage**: turn open tabs into intentions (grouped, explained, confidence-rated; asks only when unsure).
2. **Capture**: save each intention as an item: *To do*, *Follow up*, *Read* or *Keep*, with a one-line task.
3. **Close**: close everything that's captured, finished or dead, with undo.
4. **Resume**: reopen an item's tabs as a group; mark it **Done** (its tabs close and it moves to the Done archive) or **Remove** it (deleted, with undo).
5. **Repeat, incrementally**: new tabs are matched to existing items first; only the rest needs the model.

## Principles

- **Never lose an intention.** Every close is undoable; items keep the real URLs; data stays on the user's machine.
- **Confidence → peek → ask.** Low confidence: read the page. Still unclear: ask the user, batched, with likely answers.
- **Don't manufacture commitments.** A product page is a consideration, a GitHub issue may be followed rather than owned.
- **Done is the easiest close.** Detect finished things (merged PR, completed order) and say so.
- **Private by default.** Page text goes only to the model the user chose; sensitive sites are never read; nothing goes to our servers unless the user opts into the hosted tier.
- **Fast and cheap enough to run weekly.** Results stream in; repeat runs are incremental.

## What v1 delivers

1. **Install in two minutes** for a co-worker, with an onboarding that picks the model hookup for them.
2. **Tidy up**: triage with streamed results, questions, and per-intention review.
3. **Save / close / undo**: per card and in bulk.
4. **Your list** (the home screen): grouped by type; resume as a tab group, Done, Remove, search, export; a Done archive keeps finished items and their tabs.
5. **Incremental triage**: tabs that match saved items are recognized without the model; only new tabs are analyzed.
6. **Trust signals**: "already done" called out on the card; privacy explained in-product. Confidence and evidence drive when the model reads a page or asks, but stay out of the UI.

## Not in v1

Reminders and dates · syncing across devices · external to-do apps (Linear, Todoist…) · team sharing · Firefox/Safari · a hosted model tier.

## The next level (after v1)

- **Continuous mode**: notice intentions forming as tabs open (*"6 tabs about standing desks: a decision?"*) and keep tab groups aligned with intentions automatically.
- **Done detection over time**: re-check followed items (PR merged, issue closed, order delivered) and mark them done.
- **Hand-offs**: send an item to Linear / Todoist / a Slack message / a calendar slot; share an intention (tabs + why) with a teammate.
- **Hosted tier**: no key, no companion; we run the model (the paid product).
- **Everywhere**: sync between devices; Edge/Firefox.

## How we'll know it works

- Share of tabs closed after a Tidy up (POC target: most of them).
- Intentions judged right (the 👍/👎 verdicts the POC already records).
- Items resumed or marked done within two weeks (saved items get used, not just hoarded).
- Second-run time and cost vs first run.

## Decisions

| Decision | Choice (2026-10-04) | Why |
| --- | --- | --- |
| v1 audience and distribution | Co-workers, via an **unlisted** Chrome Web Store listing | Real installs and auto-updates without a public launch; store review keeps permissions and privacy honest |
| Model hookup | **Onboarding picks**: Claude Code login via ACP when available (needs the companion), otherwise the user's API key; MCP stays a power-user option | Most co-workers have Claude Code (no key needed); everyone else is one paste away |
| Surface | **Side panel + full page**: the side panel for quick triage and resume, a full page for reviewing big runs and managing Your list | Reviewing 100+ tabs needs room; resuming wants to sit next to the tabs |
| Triage | **On demand + incremental**: Tidy up when the user asks; tabs matching saved items are recognized without the model; a badge counts untracked tabs | Fast, cheap repeat runs without watching browsing in the background |
