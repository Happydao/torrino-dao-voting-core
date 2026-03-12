# torrino.dao.voting

Demo voting platform con backend Node per il recupero NFT.

## Avvio locale

1. Copia `.env.example` in `.env`
2. Imposta `HELIUS_RPC` con il tuo endpoint Helius
3. Avvia il server con `npm start`
4. Apri `http://localhost:3000`

## API backend

Endpoint disponibile:

`/api/wallet-nfts?address=WALLET_ADDRESS`

Risposta:

```json
{
  "gen1_count": 0,
  "gen2_count": 0,
  "gen1_names": [],
  "gen2_names": [],
  "voting_power": 0
}
```
