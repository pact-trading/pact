# Demo script (Operate and Scale)

PRD §9.1, without the investor and financing scenes (Tokenize is out of scope). Target 3:00, limit 4:00.
Run `pnpm preview`, open <http://127.0.0.1:3200/demo>, and press **Reset** in the demo bar before a take.

All data is mock data. Say so once on screen, and say so whenever the demo clock is moved forward
(the bar shows `+30d` in green while it is ahead of real time).

| Time | Party | Do this | Say |
| --- | --- | --- | --- |
| 0:00 | — | Landing page | “Businesses wait weeks to get paid and lose a cut to card fees. Agents can’t pay at all.” |
| 0:15 | Merchant | `/demo` → Merchant. Overview, then **Developers** (the 17-line store diff), then **Gas tank** → top up from the faucet | “Twenty lines to accept USDT on Whitechain. We pay the gas.” |
| 0:40 | Customer | `/demo` → Customer at checkout. **Continue**, **Pay $490.00**, confirm with passkey, receipt. Then `/subscribe/plan_growth` → subscribe | “The payer never sees crypto: no wallet, no gas, no network name.” |
| 1:05 | Merchant + customer | Merchant: **Customers → Jordan Lee → Website audit** → refund $90. Customer: **Purchases** shows it with its public record | “After the first payment, every step is covered.” |
| 1:25 | Merchant + customer | Merchant: open Jordan’s API Growth subscription → **Run renewal now** → refused *Too early*. Customer: the refusal is in their history; **Cancel subscription** | “The merchant’s limits are in the contract.” |
| 1:45 | AI agent | `/demo` → AI agent → **Run the agent: 11 paid calls** | “Software paying software, in USDT. The eleventh call is over its cap.” |
| 2:10 | Customer | `/invoice/inv_1042` → **Acknowledge invoice**. Demo bar → **+30 days** (“due date shortened for the demo”) → pay it, taking test USDT when the balance is short | “Invoices with reminders and a signed acknowledgement.” |
| 2:35 | Attacker | `/demo` → Attacker → **Run the drain attack** | “What stops a drain: eight layers, five in the contracts. The tank doesn’t move.” |
| 2:55 | Accountant | `/demo` → Accountant. Exports → reconciliation → **Download CSV** → open one row’s record | “Books the accountant can use, reconciled to the chain.” |
| 3:15 | — | Landing page | One line each: final in a second, refunds without chargebacks, agents can pay $0.01, rules anyone can verify. |

## Before recording

- Rehearse the order once after **Reset**; the agent’s daily cap resets with the data or with **+1 day**.
- Record at 1280×800 or larger so the merchant menu fits without scrolling.
- The explorer links open the mock explorer.
