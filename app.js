const RPC_URL = "https://mainnet.helius-rpc.com/?api-key=8b29b17a-cf4e-4de8-9a04-0dd54dacb302";
const METADATA_PROGRAM_ID = new solanaWeb3.PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const connection = new solanaWeb3.Connection(RPC_URL, "confirmed");

const COLLECTIONS = {
  torrino: {
    name: "Torrino DAO",
    address: "DKaSqu5ftJTkxr9yGyxCakooFZAi2X5aa6SGhs5yR81t",
    weight: 0.9,
  },
  solnauta: {
    name: "Solnauta",
    address: "FSKamMRcYWVWxuCzKLofdVSDgwkZ1ufEy99Q9ig3SfG4",
    weight: 0.1,
  },
};

const ui = {
  connectButton: document.getElementById("connectButton"),
  statusMessage: document.getElementById("statusMessage"),
  walletAddress: document.getElementById("walletAddress"),
  torrinoCount: document.getElementById("torrinoCount"),
  solnautaCount: document.getElementById("solnautaCount"),
  votingPower: document.getElementById("votingPower"),
  proposalVotingPower: document.getElementById("proposalVotingPower"),
  securityModal: document.getElementById("securityModal"),
  openSecurityModal: document.getElementById("openSecurityModal"),
  closeSecurityModal: document.getElementById("closeSecurityModal"),
};

initializeWalletStatus();
initializeSecurityModal();
ui.connectButton.addEventListener("click", connectWallet);

async function connectWallet() {
  const provider = getPhantomProvider();

  if (!provider) {
    setStatus(getMissingWalletMessage());
    return;
  }

  try {
    setBusy(true, "Connessione a Phantom in corso...");
    const response = await window.solana.connect();
    const walletAddress = response.publicKey.toString();

    ui.walletAddress.textContent = walletAddress;
    setStatus("Wallet collegato. Lettura degli NFT posseduti su Solana...");

    const counts = await getVotingCounts(walletAddress);
    updateDashboard(walletAddress, counts);
    setStatus("NFT caricati correttamente. Non e' stata inviata alcuna transazione.");
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error));
  } finally {
    setBusy(false);
  }
}

function initializeWalletStatus() {
  if (getPhantomProvider()) {
    setStatus("Phantom rilevato. Puoi collegare il wallet.");
    return;
  }

  setStatus("In attesa di Phantom wallet...");

  window.addEventListener("load", () => {
    window.setTimeout(() => {
      if (getPhantomProvider()) {
        setStatus("Phantom rilevato. Puoi collegare il wallet.");
      } else {
        setStatus(getMissingWalletMessage());
      }
    }, 600);
  });
}

function getPhantomProvider() {
  if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) {
    if (!window.solana) {
      window.solana = window.phantom.solana;
    }

    return window.phantom.solana;
  }

  if (window.solana && window.solana.isPhantom) {
    return window.solana;
  }

  return null;
}

function getMissingWalletMessage() {
  if (window.solana && !window.solana.isPhantom) {
    return "E' stato rilevato un wallet Solana, ma Phantom non e' il provider attivo in questo browser.";
  }

  return "Phantom wallet non e' stato rilevato in questo browser.";
}

async function getVotingCounts(walletAddress) {
  const nftMints = await getOwnedNftMints(walletAddress);

  if (nftMints.length === 0) {
    return { torrino: 0, solnauta: 0, votingPower: 0 };
  }

  const metadataAddresses = nftMints.map((mint) => getMetadataAddress(mint).toBase58());
  const metadataAccounts = await getMetadataAccounts(metadataAddresses);

  let torrino = 0;
  let solnauta = 0;

  for (const account of metadataAccounts) {
    const collectionAddress = extractCollectionAddress(account);

    if (collectionAddress === COLLECTIONS.torrino.address) {
      torrino += 1;
    } else if (collectionAddress === COLLECTIONS.solnauta.address) {
      solnauta += 1;
    }
  }

  const votingPower =
    torrino * COLLECTIONS.torrino.weight + solnauta * COLLECTIONS.solnauta.weight;

  return { torrino, solnauta, votingPower };
}

async function getOwnedNftMints(walletAddress) {
  const ownerPublicKey = new solanaWeb3.PublicKey(walletAddress);
  const result = await connection.getParsedTokenAccountsByOwner(
    ownerPublicKey,
    { programId: TOKEN_PROGRAM_ID },
    "confirmed"
  );

  return result.value
    .filter((account) => {
      const tokenAmount = account.account.data.parsed.info.tokenAmount;
      return tokenAmount.amount === "1" && tokenAmount.decimals === 0;
    })
    .map((account) => account.account.data.parsed.info.mint);
}

async function getMetadataAccounts(metadataAddresses) {
  const chunks = chunkArray(metadataAddresses, 100);
  const results = [];

  for (const chunk of chunks) {
    const publicKeys = chunk.map((address) => new solanaWeb3.PublicKey(address));
    const accounts = await connection.getMultipleAccountsInfo(publicKeys, "confirmed");
    results.push(...accounts);
  }

  return results;
}

function getMetadataAddress(mintAddress) {
  const mintPublicKey = new solanaWeb3.PublicKey(mintAddress);
  const [metadataAddress] = solanaWeb3.PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("metadata"),
      METADATA_PROGRAM_ID.toBytes(),
      mintPublicKey.toBytes(),
    ],
    METADATA_PROGRAM_ID
  );

  return metadataAddress;
}

function extractCollectionAddress(accountInfo) {
  if (!accountInfo || !accountInfo.data) {
    return null;
  }

  const bytes = accountInfo.data instanceof Uint8Array
    ? accountInfo.data
    : Uint8Array.from(atob(accountInfo.data[0]), (char) => char.charCodeAt(0));

  const candidates = [
    parseCollectionFromMetadata(bytes, { tokenStandardPresent: true }),
    parseCollectionFromMetadata(bytes, { tokenStandardPresent: false }),
  ];

  for (const candidate of candidates) {
    if (
      candidate === COLLECTIONS.torrino.address ||
      candidate === COLLECTIONS.solnauta.address
    ) {
      return candidate;
    }
  }

  return null;
}

function parseCollectionFromMetadata(bytes, options) {
  try {
    let offset = 0;

    offset += 1; // key
    offset += 32; // update authority
    offset += 32; // mint

    offset = skipBorshString(bytes, offset); // name
    offset = skipBorshString(bytes, offset); // symbol
    offset = skipBorshString(bytes, offset); // uri
    offset += 2; // seller fee basis points

    const hasCreators = readU8(bytes, offset);
    offset += 1;

    if (hasCreators === 1) {
      const creatorsLength = readU32(bytes, offset);
      offset += 4 + creatorsLength * 34;
    }

    offset += 1; // primary sale happened
    offset += 1; // is mutable

    const hasEditionNonce = readU8(bytes, offset);
    offset += 1;

    if (hasEditionNonce === 1) {
      offset += 1;
    }

    if (options.tokenStandardPresent) {
      const hasTokenStandard = readU8(bytes, offset);
      offset += 1;

      if (hasTokenStandard === 1) {
        offset += 1;
      }
    }

    const hasCollection = readU8(bytes, offset);
    offset += 1;

    if (hasCollection !== 1) {
      return null;
    }

    offset += 1; // verified
    const collectionBytes = bytes.slice(offset, offset + 32);

    if (collectionBytes.length !== 32) {
      return null;
    }

    return new solanaWeb3.PublicKey(collectionBytes).toBase58();
  } catch (error) {
    return null;
  }
}

function skipBorshString(bytes, offset) {
  const length = readU32(bytes, offset);
  return offset + 4 + length;
}

function readU8(bytes, offset) {
  if (offset >= bytes.length) {
    throw new Error("Unexpected end of metadata account");
  }

  return bytes[offset];
}

function readU32(bytes, offset) {
  if (offset + 4 > bytes.length) {
    throw new Error("Unexpected end of metadata account");
  }

  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function updateDashboard(walletAddress, counts) {
  ui.walletAddress.textContent = walletAddress;
  ui.torrinoCount.textContent = String(counts.torrino);
  ui.solnautaCount.textContent = String(counts.solnauta);
  ui.votingPower.textContent = formatVotingPower(counts.votingPower);
  ui.proposalVotingPower.textContent = formatVotingPower(counts.votingPower);
}

function formatVotingPower(value) {
  return value.toFixed(1);
}

function setBusy(isBusy, message) {
  ui.connectButton.disabled = isBusy;
  ui.connectButton.textContent = isBusy
    ? "Connessione..."
    : "Collega Phantom Wallet";

  if (message) {
    setStatus(message);
  }
}

function setStatus(message) {
  ui.statusMessage.textContent = message;
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string") {
    if (error.message.includes("User rejected")) {
      return "La connessione del wallet e' stata annullata dall'utente.";
    }

    return error.message;
  }

  return "Si e' verificato un errore imprevisto durante la lettura dei dati del wallet.";
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function initializeSecurityModal() {
  if (!ui.securityModal || !ui.openSecurityModal || !ui.closeSecurityModal) {
    return;
  }

  ui.openSecurityModal.addEventListener("click", () => {
    ui.securityModal.classList.add("open");
    ui.securityModal.setAttribute("aria-hidden", "false");
    ui.openSecurityModal.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
  });

  ui.closeSecurityModal.addEventListener("click", closeSecurityModal);

  ui.securityModal.addEventListener("click", (event) => {
    if (event.target === ui.securityModal) {
      closeSecurityModal();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.securityModal.classList.contains("open")) {
      closeSecurityModal();
    }
  });
}

function closeSecurityModal() {
  ui.securityModal.classList.remove("open");
  ui.securityModal.setAttribute("aria-hidden", "true");
  ui.openSecurityModal.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}
