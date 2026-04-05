# Call Campaign Simulator

## Build

```bash
npm install
npm run build
```

The compiled output is written to `dist/`.

## Run Demo

```bash
npm start
```

This runs a small local simulation in `demo.ts` using a mock clock and a deterministic call handler.

## Files

- `campaign.ts`: concrete `Campaign` implementation
- `solution.ts`: required assessment export
- `interfaces.ts`: provided contract, left unchanged

## Behaviour Summary

- Processes the input list in order.
- Uses retries only after their configured delay, and due retries take priority over new numbers.
- Starts new calls only during the configured working window.
- Supports `pause()` and `resume()` without cancelling active calls.
- Enforces the daily cap based on accumulated completed call duration for the current campaign-local day.
- Marks the campaign complete only after the customer list is exhausted, active calls are finished, and no retries remain pending.

## Timezone Support

- `timezone` defaults to `UTC` when omitted.
- `startTime`, `endTime`, and daily-cap reset are interpreted in the campaign timezone.
- Invalid IANA timezone values throw during construction.
- DST transitions are handled by converting campaign-local calendar boundaries to absolute timestamps.
- If a local wall-clock boundary falls into a DST gap, the simulator advances to the first valid instant after that gap.

## Assumptions

- `startTime` must be earlier than `endTime` on the same local day. Overnight windows are rejected to keep behaviour explicit.
- A call is considered successful when `CallResult.answered === true`; otherwise it is treated as a failed attempt.
- If the injected call handler rejects, the attempt is treated as a failed call with `0` duration.
- The daily minute cap is enforced against completed call usage recorded so far. In-progress calls are allowed to finish even if their final duration pushes the day over the cap.
- Call duration is tracked in exact milliseconds internally and exposed in `getStatus().dailyMinutesUsed` as fractional minutes.
- Calls that cross local midnight have their usage split across the affected local campaign days.

## Run Notes

The assessment provides the `IClock` and the call handler during tests. The implementation does not use `Date.now()`, `setTimeout()`, or `setInterval()` directly; all scheduling goes through the injected `IClock`.

## Design Notes

### Architecture

The campaign is implemented as a small scheduler with one owned timer. Any state change that may unblock work, such as `start`, `resume`, call completion, or a newly due retry, requests a scheduler tick. During each tick the campaign starts as many calls as allowed by:

- lifecycle state
- working hours
- daily budget
- concurrency limit
- retry priority

### Queueing Model

- New numbers are read sequentially from `customerList` using a cursor.
- Failed calls are stored in a retry queue ordered by `dueAt`, then by insertion order.
- When a slot opens, the campaign first consumes due retries, otherwise it advances to the next untouched number.

### Time Handling

Timezone-aware calendar calculations live inside the campaign layer. The implementation converts absolute timestamps from the injected clock into local campaign date/time parts using `Intl.DateTimeFormat`, then computes:

- whether the campaign is inside the working window
- the next working-window opening
- the next local midnight for budget reset
- per-day usage allocation for calls spanning midnight

### Edge Cases Covered

- Pause while calls are active
- Retry due while campaign is paused or outside working hours
- Daily-cap exhaustion before all numbers are processed
- Campaign completion with no remaining retries
- Timezone-local midnight resets
- DST gaps at local boundaries
