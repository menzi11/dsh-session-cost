# Session cost card

A flat card at the right of the conversation that answers two questions: **what has this session cost so far**, and **are we on peak or off-peak pricing, at what unit price**.

No shadow: the card sits on the page's own base surface and is separated by a single hairline border, so it follows the host theme in both light and dark.

## What it shows

- **Total**: estimated spend for this session, priced per request at the tier in force when that request settled.
- **Ledger**: input (cache miss) / input (cache hit) / cache write / output, each with tokens and the **amount actually billed**; the amounts add up to the total, and unit prices live in their own table further down.
- **Peak / off-peak share**: one segmented bar plus "peak · n requests" and "off-peak · m requests" totals.
- **Unit prices**: cache hit / miss / output, side by side for off-peak and peak; the current tier's column is emphasized and the other is muted.
- **Countdown**: time until the next tier switch, an "updated at HH:MM" line, and the estimation caveat.

## Prices

Off-peak list price in CNY per 1M tokens; peak is exactly 2×:

| Model | Input (cache hit) | Input (cache miss) | Output |
|---|---|---|---|
| `deepseek-flash` | 0.02 | 1 | 4 |
| `deepseek-v4-pro` | 0.15 | 4.5 | 13.5 |

Peak is Monday–Friday 09:00–12:00 and 14:00–18:00 Asia/Shanghai; every other hour, weekends, and statutory holidays bill at the off-peak rate. `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are priced as Flash; any other model name is priced as Flash and labelled as an assumption.

The price table is a constant block near the top of `client.js` (`FLASH`, `PRO`, `PRICES`, `ALIASES`). A vendor price change is an edit there plus a page reload.

## Where the numbers come from

The client reads the Session's own event window and takes `data.usage` from `assistant/message` (falling back to the last `usage` chunk in the stream) and `assistant/attempt`. Usage is de-duplicated by `turn:step`, so a retried attempt replaces its earlier sample instead of adding to it. The model comes from the message's `source.model`, falling back to the most recent `request/header`. When the window is only partially loaded, the sub-line says so.

It registers no service, appends no session event, and makes no model call.

## Known limits

- Covers the **loaded** event window only; older history of a very long session is not counted, and the card says so. DSH's own `tokenUsage` projection has whole-log token totals but no peak/off-peak split.
- The statutory holiday calendar is not modelled, and the tier comes from the message's settlement timestamp, so a request that straddles 09:00 / 12:00 / 14:00 / 18:00 can be one tier off.
- Cache writes are billed at the cache-miss input price (the same bucket semantics as `tokenUsage`), and the card states that.
- Placement is fixed (`--cst-inset-top` / `--cst-inset-right`, `z-index: 600`) and does not read the host layout or layer tokens; with the right sidebar open the card floats above it.
- The amount is an estimate, not an invoice.

## Preview

`preview.html` mirrors the shipped classes and CSS with demo data; open it directly, or add `?demo=mixed` to see a peak block and an off-peak block at the same time.
