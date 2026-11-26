---
"@xmcp-dev/x402": minor
---

Nano: add `nanoBlockPaymentPayload` for clients whose wallet signs the send but leaves publishing to the server (`payload.block`). Before the block leaves the client it is checked against the plan from `planNanoPayment`: a send, not an open block, to `payTo`, of exactly `amountRaw` counted from the caller's `previousBalanceRaw`, and for a bound offer carrying the order-commitment representative. It returns the `_meta["x402/payment"]` value and the block hash, so a call answered "published but not confirmed" can be retried with `nanoPaymentPayload` instead of signing again. Nothing signs or holds a key. Servers are unchanged.
