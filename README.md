# Forecaster Client — light PWA for VIZ Prediction Markets (testnet)

A **light, non-custodial single-page client and installable PWA** for the **Prediction Markets on the
VIZ Ledger** (the `prediction_market_api` / Onix protocol). It talks **directly to a VIZ node** — no
backend, no build step, no framework — for browsing markets, betting (instant / batch / commit–reveal),
liquidity, the lazy pool, oracle registration & resolution, disputes & DAO voting, leverage, wallet &
history, and more.

- **Default node:** **`https://testnet.viz.world/`** (change it any time in ⚙ → Node).
- **Only dependency:** the vendored `viz-js-lib` bundle (`viz.min.js`) for signing, key derivation and
  chain RPC. Chart.js is optional (graceful SVG fallback).
- **Storage:** `localStorage`/`sessionStorage` only; keys are encrypted with a PIN. Nothing leaves the
  browser except signed transactions to your chosen node.

## Stack (deliberately minimal)

- **Vanilla JS** — one `app.js`, mirroring the prototype's single-`app.js` shell.
- **viz-js-lib** — the *only* external library (signing, key derivation, chain RPC).
- **Web Crypto** (built into the browser) — AES-GCM keystore encryption. No crypto library.
- **localStorage** — the *only* storage. Keys live encrypted; node settings + language in plaintext.

```
light-client/
├── index.html      # shell: top bar, scroll area, bottom tabs, modal host
├── styles.css      # light theme adapted from the prototype
├── i18n.js         # localization dictionaries (en / ru / zh-Hans) + t()
├── app.js          # everything: node config, PIN vault, auth, router, screens
├── viz.min.js      # vendored viz-js-lib bundle
├── manifest.json   # PWA manifest
├── sw.js           # service worker (offline app shell)
├── logo.png, logo-text.svg, favicon*, *-icon-*.png   # icons
└── README.md
```

## Install as a PWA

The app is an installable **Progressive Web App**: `manifest.json` (name, icons 192/512, standalone,
theme color) + a service worker (`sw.js`) that caches the app shell for offline use. Serve it over
**HTTPS** (or `localhost`) and the browser offers *Install* / *Add to Home Screen*; it then launches
standalone with its own icon. The service worker serves same-origin assets cache-first
(stale-while-revalidate) while **node RPC and the Chart.js CDN always go to the network**, so market
data is never stale. On updates, bump `CACHE` in `sw.js` (e.g. `-v2`) to invalidate the old shell.

### Layout

The WebView itself doesn't scroll — the top bar and bottom tabs are fixed and only the middle
**`.scroll`** area scrolls (this sidesteps the Android-PWA `100vh` bug and keeps `overscroll` from
bouncing the whole app). Content sits in a centered wrapper capped at **1800px**; card lists (Markets,
Oracle) flow into a responsive grid on wide screens and collapse to one column on phones. Safe-area
insets (notch / home indicator) are respected on the bars and the toast/notification overlays.

## Languages (l10n)

Three UI languages: **English**, **Русский**, **中文 (简体)**. Pick one from the selector in
the top bar; the choice is saved to `localStorage` (`lc_lang`) and the current screen re-renders
instantly. On first run the language is auto-detected from the browser (`navigator.language`),
defaulting to English. All user-facing strings go through `t('key', {PARAM})` in `i18n.js`; add a
language by copying the `EN` block to a new locale and appending it to `DICT` + `LANGS`. Market
content (questions, outcome names) comes from the chain and is shown as-authored.

## Run it

Web Crypto needs a *secure context*, so serve over `localhost` (or HTTPS) — not `file://`:

```bash
cd light-client
python -m http.server 8080        # or:  npx serve .
# open http://localhost:8080
```

`viz-js-lib` is **vendored locally** as `viz.min.js` (the npm `viz-js-lib@0.13.4` `dist` bundle),
which includes the full `prediction_market_api` (all read methods) **and** every `pm_*` broadcast
operation (writes), so both reading markets and signing prediction-market transactions work out of the
box. Using a local file also keeps the app usable with no CDN.

### Updating viz-js-lib

**Where it comes from.** The official npm package **[`viz-js-lib`](https://www.npmjs.com/package/viz-js-lib)**
(source: <https://github.com/VIZ-Blockchain/viz-js-lib>). We vendor its prebuilt browser bundle
`dist/viz.min.js` here as `viz.min.js`. **Currently pinned: `0.13.4`.**

**Check the latest published version:**

```bash
npm view viz-js-lib version          # or: curl -s https://registry.npmjs.org/viz-js-lib/latest | grep -o '"version":"[^"]*"'
```

**Update to a specific version** (replace `X.Y.Z`), from `light-client/`:

```bash
VER=X.Y.Z
curl -fsSL "https://unpkg.com/viz-js-lib@${VER}/dist/viz.min.js" -o viz.min.js
# or via npm:  npm i viz-js-lib@${VER} && cp node_modules/viz-js-lib/dist/viz.min.js .
```

(Both npm CDNs work: `https://unpkg.com/viz-js-lib@VER/dist/viz.min.js` or
`https://cdn.jsdelivr.net/npm/viz-js-lib@VER/dist/viz.min.js`.)

**After updating:**

1. Sanity-check the bundle has prediction-market support (should print `1`, not `0`):
   `grep -c prediction_market_api viz.min.js && grep -c pm_place_bet viz.min.js`
2. Bump the pinned version string in this section and in `index.html`'s loader comment.
3. Reload the app; the top-bar node status should go green (bundle loaded + node reachable).

Keep the version **pinned** (don't track "latest" silently) so signing/serialization can't change under
you. To load from a CDN instead of vendoring, point the script tag in `index.html` at
`https://unpkg.com/viz-js-lib@0.13.4/dist/viz.min.js`.

### Market detail: outcome-ratio chart (kline)

The market page renders a **stacked-to-100% area chart** of each outcome's implied probability over
time, built from `getMarketKline(market_id, from, limit)` (the `prediction_market_api` plugin's
event-sampled parimutuel weights — a non-consensus index).

**Renderer** — if **Chart.js** (a single UMD file, loaded optionally from CDN in `index.html`) is
present, the chart is drawn with it (interactive tooltips + legend, stacked stepped-area). If Chart.js
is absent/blocked, or errors, the app transparently falls back to a **built-in inline-SVG** chart — no
dependency required. Both share the same data transform, colors, and volume sparkline. To run fully
without the CDN, drop `chart.umd.min.js` next to `index.html` (or just remove the tag to force SVG).

Common to both renderers:

- **y** = `weights[i] / bets_sum` per outcome (units cancel, so no precision division); guarded when
  `bets_sum == 0` (leading pre-first-bet points are dropped).
- **Step interpolation** — each value holds until the next event; the last value is extended to *now*
  (the series is event-sampled, not fixed-interval, so no linear interpolation or fake OHLC candles).
- **Colors** — binary: Yes = green, No = red; multi: a fixed palette. A legend shows each outcome's
  current %.
- **Volume** — a `bets_sum`-over-time step line below the area.
- **Event markers** — small dots for leverage events (`reason` 2/4/5).
- **Pagination** — lazily pulls newest→older pages (`from += 1000`) and stitches them old→new; capped
  at 3 pages here to bound calls. Rendered points are down-sampled to ~800 for a light DOM.

The chart degrades silently (shows "no history") if the node lacks the plugin or the market's kline
was pruned after its post-completion TTL.

### Markets: views, personalized feed & popularity

The Markets screen has three view chips:

- **All** — the normal browser (status filter + category chips + show-risky).
- **⭐ My feed** — newest markets drawn only from your **favorite categories**. Pick favorites via
  **★ Favorites** (a modal with a checkbox per category); the selection is saved in `localStorage`
  (`lc_fav_cats`). The feed fetches `listMarketsByCategory(sort=newest)` for each favorite, de-dupes,
  and orders by newest (highest market id). Empty until you pick at least one category.
- **🔥 Popular** — active markets ranked by **total tokens locked by bettors** (the market `volume`),
  descending. Since there's no server "popular" endpoint, it fetches active markets and sorts
  client-side by volume.

Your jurisdiction filter and the risky toggle continue to apply across all views.

## Settings (⚙): node, jurisdiction, agreement

The gear opens a **Settings** screen with three sections:

- **Node** — API node, address prefix, chain ID, and *Test connection* (below).
- **Your jurisdiction** — pick your ISO country, or **“No jurisdiction — show all markets”**. The
  chosen code is passed to `listMarketsByCategory(...jurisdiction...)` so the node applies its
  availability limits server-side, and the client additionally hides markets whose metadata bans
  that jurisdiction (`jurisdiction_banned` list or a `jurisdiction-ban:XX` tag). Stored in
  `localStorage` (`lc_jur`). The Markets screen shows the active jurisdiction; a banned market opened
  directly by URL shows a warning. "No jurisdiction" disables all filtering.
- **Agreement** — status of, and a link to review, the software agreement.

### Activity page (`#/activity`)

A tabbed page (bottom-nav **📊 Activity**, also linked from Profile) built from the user's positions
and market/dispute lookups. Five sub-tabs:

- **Trades** — every position from `getAccountPositions` (market, outcome, amount, status).
- **Active** — markets you hold a position in whose status is *active* (`getMarket` per participated market).
- **Can dispute** — your *resolved* markets that have no open dispute yet, each with an **Open dispute**
  shortcut to the market page (the market page enforces the actual grace window).
- **My disputes** — your markets that are currently in dispute, with the claim shown and a **Participate**
  shortcut (respond / vote / resolve on the market page).
- **All disputes** — a best-effort scan of recent closed/resolved markets (`listMarkets` → `getDispute`
  per market) surfacing every open dispute platform-wide. Markets whose **resolver is empty are flagged
  `DAO vote`** (decided by `pmDisputeVote`); others show `Resolver: <account>`. Disputes you took part in
  are tagged **You**. Open any to participate.

The "my" tabs require an unlocked wallet; **All disputes** is viewable while locked (voting still needs
unlock). There is no list-disputes endpoint, so the all-disputes tab scans a bounded window of markets
and notes that it is best-effort.

### Liquidity pool page (`#/pool`)

A dedicated page (reached from **Balance → Open liquidity pool**) explains how the lazy pool works
and shows live figures. The accounting follows the pool's **MasterChef reward-accumulator model**
(field names and formulas confirmed by the node plugin author):

- **Pool state** from `getLazyPool` — `total value = free_balance + allocated_balance`, available
  (`free_balance`), deployed-in-markets (`allocated_balance`), in-leverage-loans
  (`leverage_fund_used`), lifetime earned (`earned_balance`), total shares, and the lock period
  (`pm_lazy_lock_sec`).
- **Your position** from `getLazyDeposit` — shares, principal, **accrued rewards**, current value,
  and a locked/unlocked status with the unlock time. Value is computed as
  `accrued = (reward_per_share − reward_snapshot) × shares / 1e9 + pending_rewards` and
  `value = principal + accrued` (no per-share vault math — that would double-count).
- **Withdrawal estimate** — available-to-withdraw-now (`0` while locked), total position value, and
  while locked an emergency estimate `value − penalty` where
  `penalty = accrued × pm_lazy_emergency_penalty_percent / 10000` (rewards only; principal is never
  cut; default 50%).
- **Actions** — deposit; **planned withdraw** only after unlock (partial allowed, `0` = all,
  pro-rata by burned shares); **emergency withdraw** only while locked (always a full exit, penalty
  on rewards). Adding to a deposit does not reset the unlock time.

Field names are the plugin's exact ones (per the node dev); the full raw pool/position objects are
still shown in an expandable block so the numbers can be verified against the live node.

### Software agreement (first-run gate)

On first launch a blocking dialog states plainly that **Forecaster Light is only a non-custodial
software client to the VIZ Ledger** — not an operator/exchange/broker/custodian, holding no funds,
with all markets and outcomes living on-chain, keys staying on your device, and you being responsible
for legal compliance in your jurisdiction. You must tick *agree* to proceed; acceptance is stored in
`localStorage` (`lc_terms`) and can be re-read any time from Settings.

## Node selection

- Default API node: **`https://testnet.viz.world/`** (HTTPS JSONRPC).
- Open **⚙ → Node & connection** to change the node, set the address prefix (`VIZ`) and
  chain ID, and **Test connection** (reads `getDynamicGlobalProperties`, shows the head block,
  and auto-fills the chain ID if the node exposes it via `getConfig`).
- The chain ID must be correct for the target network or signed transactions are rejected.
  The field is pre-filled with the VIZ mainnet ID; **verify/adjust it for testnet** after testing.

### Node status & liveness

The top-bar indicator shows the **measured round-trip latency** to the active node (e.g. `● 45 ms`,
turning amber over ~800 ms), not a block number — the head block and node time are in the tooltip. It
is obtained by timing a `getDynamicGlobalProperties` call. A **health loop re-pings every 30 s**, but
only while the browser tab is visible (`document.hidden` is skipped), so an idle/background tab doesn't
poll the node. If a ping fails, the indicator goes offline.

### Live refresh after expiration

On the market page a one-shot timer reloads the market a few seconds after its next expiration boundary
(betting close, then result deadline), so the status flips **active → closed → resolvable/disputable**
live without a manual refresh. The timer is cleared on navigation and only fires if you're still on that
market; boundaries more than 30 min out aren't held (they re-arm when you next open the market).

### Market notifications (expiry watcher)

A lightweight **watcher registry** tracks expiration timestamps of the markets you care about — seeded
from your **bet history** (`getAccountPositions` → `getMarket`) on unlock, and updated for any market you
open. The 30 s tick (time-based, no per-market polling) compares those timestamps to *now* and, when a
market crosses a boundary, fires a **corner notification** (bottom-right): "Betting closed: …" or
"Market ended: …". Behaviour:

- **Click** a notification → opens that market (`#/market/<id>`) with fresh status + kline history.
- If you're **already on** that market, it reloads in place; if its **card is visible** in a list
  (Markets / Activity), only that card's status badge is updated via DOM selector (`[data-nav="#/market/<id>"]`).
- Notifications fire even while the tab is hidden (you see them on return); the DOM/view refresh is
  skipped while hidden. Each boundary notifies once; already-past boundaries at seed time don't fire.
- The registry is cleared on **Lock** (it's per-account).

## Security model

### Staying unlocked (PIN frequency, auto-lock, tabs)

To avoid re-typing the PIN on every reload/tab, an unlocked session is remembered in **`sessionStorage`**
(survives page reloads, cleared when the browser/tab closes) with a **sliding inactivity deadline**.
Any navigation refreshes the deadline; when it passes, the session **auto-locks and is removed from
`sessionStorage`** (checked on a 30 s tick, even while the tab is hidden). The timeout is configurable
in **⚙ → Security** (5 / 10 / 30 / 60 min, default 10). New tabs pull the unlock from an already-open
tab via `BroadcastChannel` (no PIN re-entry); if unavailable, a new tab just asks the PIN (market
browsing is public and works locked either way). **Lock** (or an auto-lock) clears the session and
**locks every open tab** (via a `storage` event + `BroadcastChannel`).

> Security trade-off: while unlocked, the decrypted keys sit in that tab's `sessionStorage` (and are
> relayed in-memory to sibling tabs), not memory-only. They're never written to `localStorage`, expire
> on inactivity, and vanish on browser close — but set a short auto-lock on shared machines. The
> encrypted vault (`localStorage`, PIN-protected) is still the only at-rest secret across restarts.

- On sign-in you provide **account + master password** *or* **account + active WIF**
  (plus optional regular WIF for DAO dispute votes). Keys are derived/validated **locally**
  and checked against the account's on-chain authority.
- Keys are then encrypted with a **PIN** (PBKDF2-SHA256 200k → AES-GCM-256) and written to
  `localStorage`. The plaintext keys exist only in memory while unlocked; **Lock** clears them.
- There is **no key recovery** — the master password/WIF is the only backup. "Forget wallet"
  wipes the encrypted blob from the browser.

## Screens & flows (→ viz-js-lib calls)

| Screen | Reads | Writes (signed ops) |
|--------|-------|---------------------|
| **Markets** | `listMarkets` / `listMarketsByCategory`, `getMarketCategories` | — |
| **Market detail** | `getMarketFull`, `getDispute`, `getAccountPositions` | `pmPlaceBet`, `pmCommitBet`/`pmRevealBet` (hidden), `pmCancelBet`, `pmAddLiquidity`, `pmOracleAcceptMarket`, `pmResolveMarket`, `pmNoContest`, `pmDisputeCreate`, `pmDisputeVote` (regular key), `pmDisputeResolve`, `pmDisputeOracleRespond` |
| **Create** | — | `pmCreateMarket` (binary & multi) |
| **Balance** | `getAccounts`, `getAccountHistory` | `transfer` |
| **Activity** (`#/activity`) | `getAccountPositions`, `getMarket`, `getDispute`, `listMarkets` | (actions happen on the linked market page) |
| **Pool** (`#/pool`) | `getLazyPool`, `getLazyDeposit`, `getPmChainProperties` | `pmLazyDeposit`, `pmLazyWithdraw` (+ emergency) |
| **Profile** | `getOracle`, `getAccountPositions` | `pmOracleRegister`, `pmOracleUpdate` (settings / insurance) |
| **Oracle** | `listMarketsByOracle` | (resolution actions on each market) |

Signer authority is **active** for every op except `pmDisputeVote`, which uses the **regular** key.
Amounts are sent as VIZ asset strings (`"10.000 VIZ"`), percents as basis points, and
`min_tokens`/`min_return` as raw ×1000 integers, per the library contract.

## In-app notices (adapted from the prototype)

Contextual notices were ported from the prototype's `i18n/en.json` and **re-framed for a thin,
non-custodial, on-chain client** (references to a server/platform replaced by protocol/on-chain
wording). They are fully translated in all three languages:

- **Bet form** — parimutuel payout estimate, slippage note, batch and hidden (commit–reveal)
  explanations.
- **Under-collateralized markets** — a risk warning plus a mandatory "I understand the risks"
  confirm that blocks the bet until ticked; markets with instant-betting disabled show a notice.
- **Oracle reliability** — the market detail fetches `getOracle(...)` and shows the reliability
  badge with a *new / low-reliability / underfunded* hint.
- **Cancellation** — a confirm explaining the position is sold at the current on-chain price and
  the return may be lower (slippage).
- **Create market** — a note on what happens to liquidity if the oracle doesn't accept / rejects.

Custodial-only notices (TON/USDT deposit conversion) were **not** ported — they don't apply to
this non-custodial thin client. Leverage **is** supported (open / close / convert) with an explicit
high-risk / liquidation notice; it is chain-gated on `pm_leverage_enabled`.

## Deliberate simplifications / notes for developers

- **Schema-tolerant rendering.** Exact field names of on-chain PM objects vary by node build,
  so market/oracle/dispute views extract common fields *best-effort* and always show the full
  **raw chain data** in an expandable block. Tighten the field mapping once you pin the node's schema.
- **Slippage guards default to 0** (`min_tokens`/`min_return`), i.e. no protection, to keep the
  test UI simple. A production client should quote first and pass real floors.
- **Commit–reveal**: the commitment is built with `viz.formatter.predictionMarketCommitment`; the
  reveal parameters (side/outcome/amount/salt) are stashed in `localStorage` so they survive a
  reload. Revealing asks for the `commit_id` returned by the node for your commit.
- This is a **light client / test tool**, not an audited wallet. Use a testnet account.
