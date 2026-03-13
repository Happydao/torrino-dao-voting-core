# Torrino DAO Voting

Piattaforma di voting per Torrino DAO con interfaccia admin, verifica wallet Phantom, salvataggio dei voti in CSV e tracciamento automatico su GitHub.

L'obiettivo del progetto e' dare alla community un sistema il piu' possibile trasparente e verificabile: il codice applicativo e i file CSV delle votazioni possono essere ispezionati pubblicamente, mentre vengono tenuti privati solo i file sensibili o strettamente interni al runtime.

## Principi di sicurezza

### 1. Conferma wallet per azioni admin

Le azioni amministrative piu' sensibili richiedono conferma tramite wallet Phantom.

Prima di eseguire:

- `Start Voting`
- `Reset Voting`

l'admin deve firmare il messaggio:

```text
Confirm admin action for Torrino DAO voting
```

Se la firma non viene approvata, l'azione viene annullata.

Questo aggiunge un secondo livello di conferma lato wallet prima di creare o resettare una proposta.

### 2. Wallet admin autorizzati

Solo i wallet admin autorizzati dal backend possono eseguire azioni di governance.

Questo significa che:

- non basta aprire la dashboard admin
- non basta modificare il frontend localmente
- il backend verifica comunque il wallet che sta tentando l'azione

### 3. Tracciabilita' dei file di voto

Ogni proposta genera un file CSV dedicato:

```text
data/proposal_<proposal_id>.csv
```

Nel file vengono registrati:

- wallet che ha creato la proposta
- timestamp di creazione
- inizio e fine votazione
- opzioni della proposta
- voti ricevuti
- potere di voto calcolato
- eventuale reset admin

Questo rende la votazione ispezionabile anche dopo la chiusura.

### 4. Storico automatico su GitHub

I file CSV vengono sincronizzati automaticamente su GitHub nei momenti chiave:

- commit iniziale dopo la creazione della proposta
- commit periodici durante la votazione attiva
- commit finale a fine votazione
- commit finale anche in caso di reset admin

In questo modo la community puo' controllare lo storico dei file e verificare che il risultato finale non venga modificato in modo opaco.

### 5. Protezione contro il doppio utilizzo degli NFT

Il backend mantiene un registro degli NFT gia' usati per votare, in modo da impedire che lo stesso asset venga contato due volte.

Questa parte e' un controllo tecnico interno del server.

## Trasparenza del progetto

Le parti piu' importanti da rendere pubbliche sono:

- codice frontend
- codice backend
- logica di autorizzazione admin
- logica di firma Phantom
- file CSV delle votazioni

Questo permette alla community di verificare:

- come viene creato un voto
- come viene confermata un'azione admin
- come vengono salvati i risultati
- come viene mantenuto lo storico dei file

## File pubblici e file privati

### Da tenere pubblici

- `admin.html`
- `admin.js`
- `index.html`
- `app.js`
- `style.css`
- `server.js`
- `data/proposal_<proposal_id>.csv`
- `README.md`

### Da tenere privati

- `.env`
- `node_modules`
- `data/used-mints.json`

`data/used-mints.json` viene tenuto privato perche' e' uno stato tecnico interno del server. Serve a prevenire il doppio voto degli NFT, ma non e' il file principale di trasparenza verso la community. Il file pubblico di riferimento resta il CSV della proposta.

## Avvio locale

1. Copia `.env.example` in `.env`
2. Imposta `HELIUS_RPC` con il tuo endpoint Helius
3. Avvia il server con `npm start`
4. Apri `http://localhost:3000`

## Endpoint principali

- `GET /api/wallet-nfts?address=WALLET_ADDRESS`
- `GET /api/proposal`
- `GET /api/results`
- `POST /api/vote`
- `POST /api/admin/proposal`
- `POST /api/admin/reset-voting`

## Nota finale

Questo progetto non basa la fiducia su un pannello admin nascosto, ma sulla combinazione di:

- wallet confirmation
- controlli backend
- file CSV verificabili
- storico pubblico su GitHub

La sicurezza percepita dalla community aumenta quando il codice e i risultati sono leggibili, mentre i soli dati realmente sensibili restano esclusi dal repository pubblico.
