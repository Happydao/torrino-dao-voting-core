# Torrino DAO Voting

Transparent Solana governance voting with public CSV records, cryptographic vote verification, admin wallet authorization, and live GitHub publishing.

Live platform:

- Voting app: `https://happydev.fi/torrino.dao.voting/`
- Admin dashboard: `https://happydev.fi/torrino.dao.voting/admin`
- Vote verifier: `https://happydev.fi/torrino.dao.voting/vote.verifier`

## Overview

Torrino DAO Voting is a lightweight governance platform designed for communities that want:

- wallet-based voting eligibility
- transparent public results
- verifiable off-chain vote signatures
- simple admin operations
- public auditability through CSV archives and open source code

The project is built for Solana communities and NFT-based governance models, but its operating model can also be useful for other DAOs that want a public, inspectable voting process without hiding the logic behind a closed backend.

## Why This Project Exists

Most community voting tools ask users to trust:

- a private database
- an opaque admin panel
- a hidden result calculation flow

This project takes a different approach.

The trust model is based on:

- public frontend code
- public backend code
- public proposal CSV files
- public vote verification
- cryptographic signatures tied to each vote
- explicit admin wallet authorization on the server

The goal is not to hide governance. The goal is to make governance readable, inspectable, and externally verifiable.

## Core Features

- NFT-based voting power calculation
- wallet connection with Phantom or Solflare
- support for multiple voting options
- public live results dashboard
- public governance history
- public vote verifier page
- admin-only proposal creation
- admin-only proposal stop/reset
- cryptographic admin confirmation for start and stop actions
- automatic CSV generation per proposal
- automatic GitHub sync during the vote lifecycle

## How Voting Power Works

The current Torrino DAO configuration uses two NFT collections:

- Torrino DAO Gen1: `0.9` voting power per NFT
- Solnauta Gen2: `0.1` voting power per NFT

Current total reference voting power in the app:

- `538.8`

The backend calculates wallet eligibility and voting power by reading wallet assets from the configured Solana RPC source and matching them against the allowed collection addresses.

## Public Transparency Model

Each proposal creates a dedicated CSV file:

```text
data/proposal_<proposal_id>.csv
```

That file is intended to be the public audit artifact for the vote.

It includes:

- proposal creator wallet
- proposal creation timestamp
- proposal signed message and signature
- proposal status metadata
- reset metadata, if voting is stopped by admin
- proposal title and description
- proposal options
- participation metrics
- every recorded vote row
- signed message and signature for each vote

During the voting lifecycle, CSV files are pushed to GitHub automatically:

- initial proposal creation
- periodic updates during the active vote
- final state when voting completes
- final state when an admin stops the vote

This means the community can inspect both:

- the current state of a vote
- the published history of its result file

## Vote Verification

The project includes a public verifier page:

```text
/vote.verifier
```

The verifier allows any user to copy three values from a public CSV row:

- `wallet`
- `signed_message`
- `signature`

and check whether the record is cryptographically valid.

The result is:

- `TRUE` if the wallet really signed that vote message
- `FALSE` if the row was altered, mismatched, or malformed

This gives the community an independent way to validate vote integrity without trusting the frontend or the admin.

## Admin Security Model

The admin page is public, but admin authority is not.

Opening `admin.html` does not grant governance access.

Real protection happens on the backend:

- only whitelisted admin wallets are accepted
- each admin action must include a valid wallet signature
- proposal creation requires a signed action message bound to the proposal payload
- proposal stop/reset requires a signed action message bound to the proposal id
- the backend verifies wallet signatures before changing proposal state

This means an external user cannot damage governance simply by discovering the admin URL.

### Admin actions currently protected

- `Start Voting`
- `Stop Voting`

### Admin proof stored publicly

For every proposal start and stop event, the system stores:

- admin wallet
- signed message
- signature

inside the proposal CSV metadata, so the community can verify that the admin really executed the action.

## Vote Security Model

Every submitted vote includes:

- wallet address
- selected option
- signed message
- wallet signature

The backend verifies:

- that the message format is valid
- that the wallet inside the message matches the sender wallet
- that the vote option matches the signed content
- that the signature is valid for that wallet
- that the message is recent enough for live vote submission

The backend then records the vote into the CSV and marks the eligible NFTs as used, preventing the same NFT from being counted twice.

## Hardware Wallet Note

The current vote flow depends on `signMessage`.

Because of that:

- standard Phantom or Solflare software wallets work with the expected flow
- some hardware wallet setups connected through Phantom or Solflare may not support message signing correctly

For those cases, the frontend now returns a specific user-facing error instead of a generic failure.

## User Flow

### Regular voter

1. Connect wallet with Phantom or Solflare
2. The backend reads eligible NFTs
3. Voting power is calculated
4. The user signs the vote message
5. The backend validates the signature
6. The vote is written into the proposal CSV
7. Live results update publicly

### Admin

1. Connect authorized admin wallet
2. Create proposal title, description, options, start time, end time
3. Sign the admin action
4. The backend verifies the admin signature
5. A new proposal CSV is created
6. CSV metadata is published and synced to GitHub

If the admin stops a proposal:

1. The current proposal is loaded
2. The admin signs a stop action linked to that proposal
3. The backend validates the signature
4. The CSV is updated with reset metadata
5. The final stopped state is published to GitHub

## Main Pages

### Voting page

Public interface for:

- wallet connection
- current proposal
- live results
- voting power view
- governance history
- transparency section
- vote verifier entry point

### Admin page

Publicly accessible UI, but operationally restricted by backend wallet authorization.

Provides:

- admin wallet connection
- proposal creation
- start voting action
- stop voting action
- countdown / in-progress reminder for active or scheduled proposals

### Vote verifier page

Public self-service tool for:

- verifying a vote row from CSV
- checking signature authenticity
- confirming that a vote was not manipulated

## Architecture

This project is intentionally simple.

### Frontend

Static files in `public/`:

- `index.html`
- `admin.html`
- `vote.verifier.html`
- `app.js`
- `admin.js`
- `vote-verifier.js`
- `style.css`

### Backend

Single Node.js server:

- `server.js`

Responsibilities:

- serve static files
- handle wallet NFT lookup
- validate vote signatures
- validate admin signatures
- persist proposal CSV data
- publish updates to GitHub
- expose verification endpoints

### Data storage

- active proposal state: `data/proposal.json`
- used NFT registry: `data/used-mints.json`
- public proposal archives: `data/proposal_<proposal_id>.csv`

## API Endpoints

### Public

- `GET /api/wallet-nfts?address=<WALLET>`
- `GET /api/proposal`
- `GET /api/results`
- `POST /api/vote`
- `POST /api/verify-vote-record`

### Admin

- `POST /api/admin/proposal`
- `POST /api/admin/reset-voting`

## Environment

Required environment variables:

- `HELIUS_RPC`

Optional:

- `PORT`
- `ADMIN_WALLET`

The code also includes a secondary admin wallet constant in the server configuration.

## Local Development

### Requirements

- Node.js
- a Solana RPC endpoint
- git configured on the host if GitHub sync is enabled

### Install and run

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## Production Notes

The live deployment typically uses:

- Nginx for public routing
- PM2 for the Node.js process

Important routing note:

- frontend pages can be served directly by Nginx
- API paths must proxy to the Node backend
- custom pages such as `/vote.verifier` may require an explicit Nginx route or redirect depending on your static file setup

## Recommended Public Repository Contents

Recommended to keep public:

- `public/`
- `server.js`
- `README.md`
- proposal CSV files under `data/`

Recommended to keep private:

- `.env`
- `node_modules/`
- `data/used-mints.json`
- any local operational secrets

`used-mints.json` is internal runtime state. The public transparency artifact is the proposal CSV.

## What Makes This Useful For Other DAOs

This project may be useful for other Solana communities that want:

- a visible and understandable voting process
- lightweight operations without a heavy governance stack
- cryptographic proof of both votes and admin actions
- public CSV archives instead of hidden result tables
- a verifier page the community can use without asking the admin

It is especially relevant for DAO teams that want a custom governance surface while preserving strong transparency.

## Limitations

- voting is off-chain, even if signatures are cryptographically verifiable
- final trust still depends on operating the backend honestly and publishing updates as designed
- hardware wallet support for `signMessage` is not universal
- current logic is tailored to the Torrino DAO collections and weights

## Summary

Torrino DAO Voting is not trying to hide governance complexity behind a closed admin panel.

It turns governance into something the community can:

- read
- inspect
- verify
- archive

That is the core design principle of the project.
