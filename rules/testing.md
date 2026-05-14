# Testing

There is no automated test suite yet. Every PR is verified manually against a running extension.

## Smoke test (every PR)

```bash
npm run typecheck
npm run lint
npm run build
```

Then load `dist/` into `chrome://extensions` (Developer mode → Load unpacked → re-load if already loaded).

## Manual matrix

For changes touching capture, run at least these flows before merging:

1. **Local mode, bounded range**
   - Pick `30d`, click Download. Confirm: progress shows the date window; on completion, browser downloads `miyo-capture-...-chrome.zip` with markdown files in range.
   - Click Stop mid-flight. Confirm: IDB buffer cleared, popup returns to idle.

2. **Local mode, `All available`**
   - Click Download. Confirm: walks every page, finishes with a zip.

3. **Miyo mode** (requires Miyo desktop running on `127.0.0.1:8742`)
   - Bounded range. Confirm: items POST to Miyo.
   - `All available` on a library where prior syncs were bounded. Confirm older items get captured (regression test for the dropped early-stop).
   - Pause mid-flight. Reopen popup. Confirm Resume + Discard appear; Resume picks up at the same cursor.

4. **Miyo offline**
   - Stop Miyo desktop. Open the popup. Confirm: the Miyo toggle shows disconnected, default mode is local Download.

5. **Sign-out edge case**
   - Sign out of ChatGPT or Claude in another tab during a capture. Confirm: capture aborts with "You are signed out."

## When to add automation

If a regression makes it past manual testing twice, add a unit test for the offending function (most framework code in `src/framework/` is pure and easily testable with Node's built-in `node:test`). Adapter HTTP layers and the SW dispatch can be tested with `vitest` + fetch mocks.
