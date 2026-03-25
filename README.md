# Torrino DAO Voting

Transparent Solana governance with:

- no vote fees
- public CSV records
- cryptographic vote signatures
- public manual verification
- up to 2 proposals live at the same time
- support for custom voting models, including NFT-based and token snapshot-based governance

Live links:

- Voting app: `https://happydev.fi/torrino.dao.voting/`
- Admin dashboard: `https://happydev.fi/torrino.dao.voting/admin`
- Vote verifier: `https://happydev.fi/torrino.dao.voting/vote.verifier`

## What Makes This Platform Different

This platform is built around a simple idea:

**governance should be readable, verifiable, and public.**

Instead of hiding votes inside a closed database, Torrino DAO Voting publishes each proposal as a public CSV file, stores a cryptographic signature for every vote, and gives anyone a public verifier tool to check vote integrity by hand.

The result is a governance system that is:

- easy for users to understand
- lightweight to use
- free to vote with
- transparent by design
- externally auditable

## Core Principles

### No Fees

Users do not pay blockchain transaction fees to cast a vote.

Each vote is signed with the wallet and then verified by the backend before it is recorded.

### Full Transparency

Every proposal generates a public CSV file.

That file contains:

- proposal metadata
- admin start proof
- admin stop proof, if applicable
- proposal payload hash
- proposal title, description, and options
- participation rates
- live result percentages per option
- every recorded vote row
- signed message and signature for every vote

During voting, the CSV is automatically updated and pushed to GitHub every 10 minutes.

### Cryptographic Verification

Every vote includes:

- wallet
- signed message
- signature

The signed message is tied to:

- the proposal file name
- the `proposal_payload_hash`
- the selected option
- the wallet
- the timestamp

This means a vote is not just recorded. It is also cryptographically linked to the exact proposal content being voted on.

## Proposal Payload Hash

Each proposal is hashed from this exact JSON structure:

```json
{
  "title": "Treasury allocation Q2",
  "description": "Should the DAO allocate 10% of the treasury to growth initiatives?",
  "options": ["CONFIRMED", "REJECTED"]
}
```

This `proposal_payload_hash` is saved in the CSV metadata and also included in the signed vote message.

Why this matters:

- if the proposal text changes, the hash changes
- if the hash in the signed message does not match the proposal, the vote fails verification
- anyone can manually rebuild the hash and check it

## Manual Vote Verifier

The verifier page is public:

```text
/vote.verifier
```

It is intentionally manual and transparent.

A user can:

1. open the public CSV
2. copy:
   - `proposal_payload_hash`
   - `proposal_title`
   - `proposal_description`
   - `proposal_options`
   - `wallet`
   - `signed_message`
   - `signature`
3. run one check

The verifier then tells the user:

- the rebuilt proposal hash
- whether that hash matches the hash entered from the CSV
- whether the same hash appears inside the signed message
- whether the wallet signature is valid

This means users do not need to trust the frontend, the admin, or even GitHub alone. They can verify vote integrity themselves.

## Two Proposals In Parallel

The platform supports up to **2 active proposals at the same time**.

Each proposal keeps its own:

- CSV file
- vote rows
- signatures
- live dashboard
- NFT usage state

If both proposals are active:

- users see both proposals clearly in the voting page
- each proposal requires its own wallet confirmation
- results are tracked separately

## Voting Power Model

Torrino DAO currently uses two NFT collections:

- **Gen1** = fixed `90%` of total treasury voting power
- **Gen2** = fixed `10%` of total treasury voting power

Per-NFT weight:

- Gen1: `90 / 500 = 0.180000`
- Gen2: `10 / 888 = 0.011261261...`

Maximum total voting power:

- `100`

The backend keeps enough precision to preserve the intended 90/10 split correctly at quorum.

## Not Limited To NFTs

The current live setup uses NFTs, but the platform concept is broader than that.

It can also be adapted for:

- governance based on fungible tokens
- token-holder snapshots taken before a vote starts
- allowlisted wallet voting
- custom weight rules defined by the DAO

In other words, the same transparency and verification model can be reused for communities that do not vote with NFTs at all.

For another DAO, the voting power source can be changed from NFT ownership to a snapshot of wallets holding a governance token, while keeping the same core benefits:

- no vote fees
- public CSV records
- signed votes
- public verification
- readable governance history

## How A Vote Works

### Voter flow

1. Connect Phantom or Solflare
2. The platform reads eligible NFTs
3. Voting power is calculated
4. The user selects an option
5. The wallet signs the vote message
6. The backend verifies the signature
7. The vote is written to the CSV
8. Results update publicly

If 2 proposals are active, the user signs once for each proposal they vote on.

### Admin flow

1. Connect an authorized admin wallet
2. Create 1 or 2 proposals
3. Set readable proposal file names
4. Sign the admin start action
5. The backend verifies the admin signature
6. CSV files are created and published

If voting is stopped:

1. The admin signs a stop action
2. The backend verifies the signature
3. The CSV is updated with reset metadata
4. GitHub is updated with the final stopped state

## Admin Security

The admin page is public, but admin power is not.

Backend protection is based on:

- whitelisted admin wallets
- signed admin actions
- signature verification before any state change

So knowing the admin URL is not enough to create or stop proposals.

## Public CSV Format

Each proposal is published as:

```text
data/<PROPOSAL_NAME>_<YYYY-MM-DD>.csv
```

This keeps governance history readable both on the server and on GitHub.

The same readable CSV name is also used across the user interface, verifier, and vote signed messages.

## Why This Matters

Many voting systems ask the community to trust the platform.

Torrino DAO Voting tries to reduce that trust as much as possible by making the process public:

- open source code
- public CSV files
- public results
- manual verifier
- cryptographic signatures
- no fees for voters

The goal is simple:

**make governance easy to use, but hard to fake.**

## Project Structure

```text
public/
  index.html              Public voting page
  admin.html              Admin dashboard
  vote.verifier.html      Manual verification page
  app.js                  Voting frontend logic
  admin.js                Admin frontend logic
  vote-verifier.js        Verifier frontend logic
  style.css               Shared styles

data/                     Proposal CSV files
server.js                 Node backend
README.md
LICENSE
```

## License

This project is open-source under the Apache License 2.0.

See [LICENSE](./LICENSE).
