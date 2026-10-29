# Project submission

**Project:** Fourward — multiplayer four-in-a-row  
**Author:** Yitong Wu  
**Live demo:** https://fourward-yitong-wu.bradley9900.chatgpt.site  
**Source:** https://github.com/aryawuyitong/fourward-multiplayer

> Deployment, automated checks, public API checks, and independent browser-session play are verified in the testing report. Before submitting, complete the physical-device checklist and personalize the reflection.

## Handshake submission fields

| Field | Suggested value |
| --- | --- |
| Project title | Fourward — Multiplayer Four-in-a-Row |
| Your project URL | https://fourward-yitong-wu.bradley9900.chatgpt.site |
| Preview image | [`docs/screenshots/cover.jpg`](screenshots/cover.jpg) |

The form recommends a **3:2 preview image at least 1200 pixels wide**. Verify the prepared cover image before uploading.

**Description draft — 468 characters, including spaces and punctuation; within the 500-character limit:**

```text
Fourward is a two-player four-in-a-row game with shareable rooms, enforced turns, reconnecting seats, and rematches. The main engineering challenge was keeping clients consistent during duplicate moves and disconnects; server validation and revision checks address it. Socket.IO powers the Node version; the public demo uses D1 and one-second polling. Built with ChatGPT/Codex assistance. Next: complete physical-device acceptance testing and add durable Node storage.
```

This is proposed project text for Yitong Wu to review and personalize. Add personal observations about what was fun or learned only after playing and reviewing the implementation. Detailed AI-assistance disclosure and evidence are in the [README](../README.md) and [development record](DEVELOPMENT.md).

## Extended project summary

Fourward is a two-player four-in-a-row game that lets friends create a room, share a code or invite link, and play from separate browsers. The game explains its own rules and shows turns, connection status, the winning line, and cumulative scores across rematches.

The server owns the board and validates every action. It rejects out-of-turn moves, full columns, stale requests, and moves after a round ends. Secret seat tokens support reconnecting in the same tab, while reserved seats prevent someone from replacing a temporarily disconnected player. Both players approve a rematch, and the starting player alternates.

The Node version uses Socket.IO rooms. The public deployment uses the same rules engine with Cloudflare Workers, D1 storage, and one-second HTTP polling. This is an intentional hosting tradeoff for a turn-based game. Automated tests exercise legal wins, a full-board draw, competing requests, room isolation, reconnects, and expiry. The repository includes architecture, a development record, test evidence, and a physical-device acceptance checklist.

ChatGPT/Codex assisted with implementation, tests, debugging, documentation, and deployment preparation. The documentation distinguishes verified behavior from checks that still require manual evidence.

## Links and evidence to attach

- [Playable demo](https://fourward-yitong-wu.bradley9900.chatgpt.site)
- [GitHub repository](https://github.com/aryawuyitong/fourward-multiplayer)
- [Architecture and tradeoffs](ARCHITECTURE.md)
- [Development and review record](DEVELOPMENT.md)
- [Test results and physical-device checklist](TESTING.md)
- [Desktop screenshot](screenshots/desktop.jpg), [mobile viewport screenshot](screenshots/mobile.jpg), [match screenshot](screenshots/match.jpg)

Review the final evidence and adapt this summary before submitting. Add any personal reflection after playing the game and reviewing the implementation.
