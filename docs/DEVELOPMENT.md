# Development record

**Fourward · Yitong Wu · October 29, 2026**

This record captures design decisions and reproducible checks from the project build.

## Scope and approach

The brief asks for a multiplayer game with understandable rules and a reachable host. Four-in-a-row makes those requirements testable: two reserved seats share a small board, turns are explicit, and both players must agree on the result.

The initial design was a Socket.IO room per match. That design is retained in the Node version. A second adapter uses a Cloudflare Worker and D1 with HTTP polling, allowing the same authoritative game to run on the available public hosting platform. Polling is an explicit compromise for a turn-based game, not a claim of WebSocket delivery.

Implementation concentrated on the complete path first: create a room, join its second seat, submit legal moves, and finish a round. The shared rules and storage contract then made it possible to check edge cases without duplicating game logic between hosts.

## Decisions with a purpose

- **Server-owned board:** The browser sends a column and expected revision. It cannot set the board or announce a win. Turn enforcement and agreement between devices remain server responsibilities.
- **Reserved seats:** Losing a connection does not let someone else take the seat. A secret token restores the seat from the saved tab session.
- **Paused play:** The game waits for an offline opponent instead of inventing a timeout loss. The interface explains the pause.
- **Two rematch votes:** A completed round stays visible until both agree. Scores remain while the starting player alternates.
- **Readable interaction:** Numbered discs and columns supplement color. Buttons and keys 1–7 provide input, and the layout adapts to narrow screens.
- **Evidence over claims:** Automated tests, independent browser sessions, and physical devices are separate forms of verification. The report labels what has and has not been completed.

## Review finding: expiry during an asynchronous read

**Failure mechanism:** An authenticated state request first loaded a live room, then awaited token verification and a heartbeat write. Its final response read the stored record directly. If the request crossed expiry while waiting, the service could return an expired snapshot; if another request collected the record, it could try to project a missing record.

**Correction:** The final read now uses the room-loading method that checks existence and expiry. The storage heartbeat also refuses to refresh an already expired room. A delayed request receives the normal room-not-found response rather than stale state.

**Verification:** A deterministic clock advances past the inactivity limit during the awaited heartbeat path. The expected result is `ROOM_NOT_FOUND`. The regression runs against MemoryStore and D1Store through a real SQLite adapter. See [the testing report](TESTING.md) for final command results.

The correction was made during development review.

## Duplicate actions and competing joins

Repeated clicks and two simultaneous join requests are expected multiplayer conditions. They are covered as design requirements: every mutation carries an expected revision, and the store atomically compares it before committing.

The suite submits competing requests with the same revision and verifies that only one commits. A second seat likewise cannot be claimed by two players. These regressions document the concurrency guard's behavior.

## Browser-driven refinements

The first mobile layout put the invitation panel above the board throughout a match. At 390px this pushed the main game below the first screen. The final layout keeps the invitation first while waiting, then puts the board first after both seats are filled. Mobile column controls were increased from 34px to 44px tall. A screenshot review also caught words joining when narrow layouts hid a `<br>`; explicit whitespace now preserves word boundaries.

Integration checks initially compared complete state objects, including `expiresAt`. Heartbeats extend this timestamp, so otherwise identical game snapshots could differ by one millisecond. The final tests compare every game field while checking expiry validity and monotonic extension separately. This corrects the test's assumption without weakening board, score, turn, or revision agreement.

## Remaining boundaries

The game stays small: two players, no spectators, no accounts, and no long-term leaderboard. Secret tokens are not account recovery. Closing a tab may lose its seat. The Node version keeps rooms in memory, and the public version incurs polling requests while a room is active. Distributed abuse prevention and large-scale operation are outside the implemented scope.

The physical-device acceptance test must be completed and recorded by the project owner before describing that check as passed.

## AI assistance

ChatGPT/Codex assisted with code, interface implementation, tests, review, debugging, documentation, and deployment preparation. The repository preserves inspectable code and evidence so the work can be reviewed beyond the finished screen. Any personal reflection should be written or edited by Yitong Wu after reviewing and playing the game.
