# Testing and evidence

**Fourward · Yitong Wu · October 29, 2026**

Automated checks validate rules and state handling. Browser checks validate interaction and synchronization. A physical-device check validates the experience across devices and networks. These are recorded separately.

## Automated verification

Run from the repository root with Node.js 22.13+; Node.js 24 is recommended:

```sh
npm --prefix app ci
npm --prefix app test
npm --prefix app run check
```

| Area | Checks |
| --- | --- |
| Rules | Gravity, turns, column bounds, full columns, horizontal and both diagonal directions, vertical wins, a complete legal 42-move draw |
| Finished rounds | Winner, winning cells, score agreement, rejected post-game moves, both-player rematch consent, alternating starter |
| Concurrency | Duplicate moves commit once; simultaneous joins claim only one second seat; stale revisions rejected |
| Lifecycle | Separate rooms remain isolated, third seat refused, deliberate leave closes the room, inactivity expiry |
| Identity | Seat reconnect, wrong or missing tokens rejected, no credentials in public state |
| Presence | Offline opponent pauses moves, reserved seat, authenticated heartbeat restores presence |
| Expiry regression | Expiry during an awaited state request returns room-not-found instead of an expired snapshot |
| HTTP | JSON routes and errors, malformed or oversized request rejection, same-origin checks |
| Transport | Independent Socket.IO clients receive scoped updates through the Node adapter |

The same service behavior is checked with MemoryStore and D1Store. The D1 adapter executes its SQL against Node's actual SQLite database through a small D1-shaped API adapter. This checks SQL behavior and compare-and-set semantics; it is **not** a Cloudflare-runtime or production-network test.

GitHub Actions installs lockfile dependencies and runs the complete test/build/validation command on Node.js 24. A configured workflow is not evidence that a particular remote run passed; consult its run status.

### Final run record

| Check | Status / evidence |
| --- | --- |
| Local automated tests | **40 passed, 0 failed, 0 skipped**, `npm run check`, Node.js 25.8.1 on macOS, October 29, 2026 |
| Worker bundle build | **Passed**; shared service and embedded static assets bundled as ESM |
| Artifact validation | **Passed**; built module imports and exports `default.fetch` |
| GitHub Actions run | Pending upload and remote run |
| Public deployment health and API | **Passed**; version 2 published; live smoke script passed 50 requests, then closed its test room |

## Browser verification

Browser QA used Google Chrome on one Mac with two independent tab sessions. The local Socket.IO adapter and public polling adapter each completed a full horizontal win. These are browser-session checks, not two physical devices.

| Scenario | Expected result | Actual result |
| --- | --- | --- |
| Desktop layout | Rules, form, board, statuses remain readable | Passed; actual entry and match screenshots attached |
| Narrow mobile viewport | No horizontal page overflow; columns usable | Passed at 360px and 390px; final 390px controls are 44px tall; full room places board first |
| Two independent browser sessions | Create/join, moves, final result agree | Passed locally and publicly; alternating columns 1,1,2,2,3,3,4 produced Player 1 win, seven discs, score 1–0 |
| Reload original playing tab | Same saved seat and board restored | Passed locally in round 2; Player 2 retained its seat and score |
| Opponent interruption and recovery | Pause, preserved board, resumed turns | Passed locally; navigating Player 2 away beyond grace paused Player 1; returning restored the same seat and one-disc board |
| Both players request rematch | Empty board, retained score, alternate starter | Passed locally in browser and publicly via live script; round 2 starts with Player 2 and score 1–0 |
| Invite link | Only code shared; form identifies invited room | Passed locally and publicly; invited room code prefilled, second seat independently joined |
| Keyboard and rules | Keys 1–7 submit moves; rules explain the game | Passed locally; key 4 placed Player 2 disc in round 2; rules dialog opened and Escape closed it |
| Leave confirmation | Accidental leave can be cancelled | Passed locally; “Keep playing” dismissed confirmation and retained room |

Screenshots: [`desktop.jpg`](screenshots/desktop.jpg) (local entry), [`mobile.jpg`](screenshots/mobile.jpg) (public match, 390px viewport), [`match.jpg`](screenshots/match.jpg) (public completed game), [`cover.jpg`](screenshots/cover.jpg) (1440×960 public game cover). A resized desktop viewport is not a physical-device test.

### Reproduce the public API check

```sh
node app/scripts/smoke-live.mjs https://fourward-yitong-wu.bradley9900.chatgpt.site
```

This script creates a disposable room and two seat credentials in memory, verifies health, third-seat rejection, invalid authentication, turn enforcement, stale requests after every move, both-client state agreement, a complete win, and a consensual rematch with an alternating starter. It closes the room in `finally` and never prints credentials. The observed successful run reported **50 requests** before cleanup.

## Two physical devices: acceptance checklist

**Status: not yet performed or verified.** Complete this checklist using the public URL. Ideally use different networks—for example, a laptop on Wi-Fi and a phone on cellular—to prove the game does not depend on the same local network.

| Evidence field | Recorded value |
| --- | --- |
| Date and time | Pending |
| Public URL | https://fourward-yitong-wu.bradley9900.chatgpt.site |
| Device A / OS / browser | Pending |
| Device B / OS / browser | Pending |
| Networks used | Pending |
| Room code | Pending — invitation code only, never seat tokens |
| Result / screenshot references | Pending |
| Tester | Pending |

- [ ] Open the public URL independently on both physical devices.
- [ ] On device A, enter a name and create a room.
- [ ] On B, use the shared code or invite link to join with a different name.
- [ ] Confirm the same names, room, empty board, and starting player.
- [ ] Play this vertical-win sequence, alternating devices: **A:1, B:2, A:1, B:2, A:1, B:2, A:1**.
- [ ] After every turn, confirm identical disc positions and exactly one turn change.
- [ ] Confirm both show A as winner, the same highlighted four discs, and score **1–0**.
- [ ] Confirm extra moves are disabled after the win.
- [ ] Request a rematch on A only; confirm the completed result remains visible.
- [ ] Request a rematch on B; confirm an empty board, retained score, and B starting.
- [ ] Make one move, reload its original tab, and confirm seat and board restoration.
- [ ] Disconnect one device long enough for its heartbeat to age beyond the presence grace; confirm the other pauses without losing the board.
- [ ] Reconnect in the original tab and confirm play resumes with the same seat.
- [ ] Open the room in a third independent session and confirm it rejects another player.
- [ ] Deliberately leave on one device and confirm both show a closed room.
- [ ] Attach screenshots and complete the evidence fields.

If a step fails, record the device, action, expected result, observed result, and reproduction steps before changing code. Re-run the affected path after the fix.
