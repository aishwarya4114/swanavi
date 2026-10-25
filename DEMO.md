# Five-minute live demo (Mastercard judges' checklist)

Everything shown is live on the XRPL EVM testnet. Nothing is pre-recorded; what is pre-staged is listed.

Judges look for: an agent that reads a 402 and pays with no human in the loop; `VoucherRedeemed` on the explorer;
the merchant payout wallet's balance changing; an over-cap attempt rejected; a cancelled booking that was never
signed; an over-quote refused before signing; and the unused cap coming back at trip close.

## Before going on stage (10 minutes before)

1. **Open the demo channel** (30–60 s; uses the DEMO channel opening):
   `AGENT_PRIVATE_KEY=… CONFIRM_OPEN=yes CAP=0.10 PAY=0 node scripts/live_merchant_channel.mjs`
   Copy the printed `TRIP_CHANNEL_ID`. `PAY=0` leaves it open with nothing paid.
2. **Terminal A: sellers.** Tour is priced above its lock on purpose (the overcharge refusal).
   `MERCHANT_SUBMITTER_KEY=… MERCHANT_ID=… MERCHANT_PAYOUT=0x4581492018e07F81F055D15BC7EBab4957A1Ce0C PRICE_TOUR=0.05 node x402_sellers.mjs`
3. **Terminal B: server, live**, with a spend ceiling the demo cannot exceed:
   `SWANAVI_TOKEN=… PAYMENTS_MODE=ap4m X402_SELLERS=http://127.0.0.1 REAL_SPEND_CEILING=0.05 TRIP_CHANNEL_ID=… AGENT_PRIVATE_KEY=… node server.mjs`
   Wait for `escrow listening … badge LIVE`.
4. **Browser tabs**: the dashboard `http://127.0.0.1:8787/`; the explorer page of the merchant wallet
   `https://explorer.testnet.xrplevm.org/address/0x4581492018e07F81F055D15BC7EBab4957A1Ce0C`; the over-cap
   transaction `https://explorer.testnet.xrplevm.org/tx/0xd12c1d9beccbafff09216e2fa65ea1353e8ada42fdf3588fd964850a98f8100a`.
5. **Terminal C**: `T=<the token>`; `node scripts/merchant_status.mjs` to show the wallet's RLUSD **before**.

## On stage (about 5 minutes)

**0:00 Frame it (30 s).** "The agent plans a trip and pays four sellers. It locks the quoted price, pays only on
delivery, never signs for a cancelled booking, refuses a bill above the quote, and the ledger itself caps what the
channel can ever pay. Everything you see is live on testnet."

**0:30 Paid booking over x402 (90 s).** Terminal C:

```bash
curl -s -H "X-Swanavi-Token: $T" -X POST localhost:8787/escrows -H 'Content-Type: application/json' -d '{"sellerId":"hotel","amount":"0.01","deadlineSeconds":600}'
curl -s -H "X-Swanavi-Token: $T" -X POST localhost:8787/escrows/<id>/release -H 'Content-Type: application/json' -d '{}'
```

Say: "The agent fetched the seller's resource, got HTTP 402 with a price, checked it against the lock, signed one
cumulative voucher, and the seller submitted it. No human approved anything." Show `paidVia: x402`, `txHash`,
`explorerUrl`; click it: **`VoucherRedeemed` on the explorer**. Dashboard meter moves from reserved to spent.

**2:00 Cancelled booking (30 s).** Lock `cab` 0.01, then `POST /escrows/<id>/refund`. Say: "Cancelled before
delivery. Nothing was signed; the lock was only a number in the server, so the chain never moved." Show the
dashboard: refunded, no tx.

**2:30 Overcharge refused (30 s).** Lock `tour` 0.01, release. Response is `409 overcharged`,
`reason x402_price_exceeds_lock`, `finalBill 0.05`. Say: "The seller asked 0.05 against a 0.01 quote. Refused before
any signature; the reservation went back to the budget."

**3:00 Over-cap rejected by the ledger (30 s).** Show the explorer tab of
`0xd12c1d9b…f8100a`: a voucher for cap + 1 wei, **reverted by the PaymentLedger**. Say: "That is not our code
refusing; the contract refused. Our server also refuses earlier (`409 over_cap`), and `REAL_SPEND_CEILING` caps the
whole session, but the ledger is the hard limit even if our code were wrong."

**3:30 Merchant wallet balance (30 s).** Terminal C: `node scripts/merchant_status.mjs`. RLUSD is up by the paid
amount once the service settled (usually within a minute; the dashboard shows the receipt link when it is
published). Explorer tab of the wallet shows the incoming transfer.

**4:00 Trip close (60 s).** `curl -s -H "X-Swanavi-Token: $T" -X POST localhost:8787/trip/close`. Say: "The trip is
over. Unused cap goes back to the funding vault on chain." Response shows `closeTxUrl`, `payoutClosedTxUrl`,
`returned`. Click `payoutClosedTxUrl`: **`PayoutClosed`** with the returned amount. Done.

## If a 503 happens on the paid booking

Say: "The seller's confirmation to the agent was lost; the payment itself is on chain, and the server is checking
that now." Within ~10 s the server re-reads the channel and replays the retained signed header; the booking becomes
`delivered` with the real `txHash` without a second signature. If it answers `503 redeem_unconfirmed`, run the same
release once more: it only retries the confirmation and can never pay twice. Show the explorer meanwhile: the
`VoucherRedeemed` event is already there. This is the "recovers within budget" point; say so.

## Fallback

- Sellers down or no 402: the server answers `502 seller_unavailable` and signs nothing. Restart terminal A and
  release again, or set no `X402_SELLERS` and restart B: `release` then signs the voucher directly (same
  `VoucherRedeemed`, `paidVia: voucher`).
- RPC very slow: `AP4M_RPC_URL=https://1449000.rpc.thirdweb.com` for both A and B (public alternative; same chain).
- Channel problem: the SPARE opening exists for exactly this; `PAY=0 CONFIRM_OPEN=yes node scripts/live_merchant_channel.mjs`
  and restart B with the new `TRIP_CHANNEL_ID`. Three channels can be open at once; close one first if needed.
- Nothing on chain works: switch to the mock server (`SWANAVI_TOKEN=… node server.mjs`) and say clearly that it is
  mock; show the earlier real transactions on the explorer instead (the two hashes above and the merchant wallet
  history). Never present mock output as live.
