const API_ENDPOINT = "/api/wallet-nfts";
const VOTE_ENDPOINT = "/api/vote";
const RESULTS_ENDPOINT = "/api/results";
const textEncoder = new TextEncoder();
const state = {
  walletAddress: null,
  walletData: null,
  voteFeedbackTimeoutId: null,
  resultsPollIntervalId: null,
};

const ui = {
  connectButton: document.getElementById("connectButton"),
  statusMessage: document.getElementById("statusMessage"),
  walletAddress: document.getElementById("walletAddress"),
  torrinoCount: document.getElementById("torrinoCount"),
  solnautaCount: document.getElementById("solnautaCount"),
  torrinoNames: document.getElementById("torrinoNames"),
  solnautaNames: document.getElementById("solnautaNames"),
  votingPower: document.getElementById("votingPower"),
  proposalVotingPower: document.getElementById("proposalVotingPower"),
  yesButton: document.querySelector(".yes-button"),
  noButton: document.querySelector(".no-button"),
  voteFeedback: document.getElementById("voteFeedback"),
  solnautaVoted: document.getElementById("solnautaVoted"),
  torrinoVoted: document.getElementById("torrinoVoted"),
  yesPower: document.getElementById("yesPower"),
  noPower: document.getElementById("noPower"),
  yesPercent: document.getElementById("yesPercent"),
  noPercent: document.getElementById("noPercent"),
  yesBar: document.getElementById("yesBar"),
  noBar: document.getElementById("noBar"),
  securityModal: document.getElementById("securityModal"),
  openSecurityModal: document.getElementById("openSecurityModal"),
  closeSecurityModal: document.getElementById("closeSecurityModal"),
};

initializeWalletStatus();
initializeSecurityModal();
initializeResultsPolling();
ui.connectButton.addEventListener("click", connectWallet);
ui.yesButton.addEventListener("click", () => submitVote("yes"));
ui.noButton.addEventListener("click", () => submitVote("no"));

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

    state.walletAddress = walletAddress;
    ui.walletAddress.textContent = walletAddress;
    setStatus("Wallet collegato. Lettura NFT dal backend in corso...");

    const walletData = await getWalletNfts(walletAddress);
    state.walletData = walletData;
    updateDashboard(walletAddress, walletData);
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

async function getWalletNfts(walletAddress) {
  const response = await fetch(`${API_ENDPOINT}?address=${encodeURIComponent(walletAddress)}`);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error ? payload.error : "Errore durante la lettura NFT.");
  }

  return payload;
}

async function submitVote(vote) {
  const provider = getPhantomProvider();

  if (!provider || !state.walletAddress || !state.walletData) {
    setStatus("Collega prima il wallet per poter votare.");
    showVoteFeedback("An error occurred while submitting the vote.", "error");
    return;
  }

  if ((state.walletData.gen1_count + state.walletData.gen2_count) === 0) {
    setStatus("Il wallet collegato non possiede NFT validi per il voto.");
    showVoteFeedback("An error occurred while submitting the vote.", "error");
    return;
  }

  try {
    clearVoteFeedback();
    setVotingBusy(true, `Invio voto "${vote.toUpperCase()}" in corso...`);
    const signature = await signVoteMessage(provider, vote);
    const response = await fetch(VOTE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: state.walletAddress,
        vote,
        signature,
      }),
    });
    const payload = await response.json().catch(() => null);

    if (response.ok && payload && payload.success === true) {
      setStatus(`Voto registrato. Potere di voto usato: ${formatVotingPower(payload.voting_power)}.`);
      showVoteFeedback("Vote successfully recorded.", "success");
      await refreshResults();
      return;
    }

    if (payload && payload.error === "NFT_ALREADY_VOTED") {
      setStatus("Uno o piu' NFT risultano gia' utilizzati per il voto.");
      showVoteFeedback("One or more of your NFTs have already voted.", "error");
      return;
    }

    throw new Error(payload && payload.error ? payload.error : "SERVER_ERROR");
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error));
    showVoteFeedback("An error occurred while submitting the vote.", "error");
  } finally {
    setVotingBusy(false);
  }
}

function initializeResultsPolling() {
  refreshResults();

  if (state.resultsPollIntervalId) {
    window.clearInterval(state.resultsPollIntervalId);
  }

  state.resultsPollIntervalId = window.setInterval(() => {
    refreshResults();
  }, 10000);
}

async function refreshResults() {
  try {
    const response = await fetch(RESULTS_ENDPOINT);
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      throw new Error("SERVER_ERROR");
    }

    updateResultsDashboard(payload);
  } catch (error) {
    console.error(error);
  }
}

async function signVoteMessage(provider, vote) {
  if (typeof provider.signMessage !== "function") {
    return "not-signed";
  }

  const message = `Torrino DAO vote:${vote}:wallet:${state.walletAddress}:timestamp:${Date.now()}`;
  const signatureBytes = await provider.signMessage(textEncoder.encode(message), "utf8");

  if (!signatureBytes || !signatureBytes.signature) {
    return "not-signed";
  }

  return bytesToBase58(signatureBytes.signature);
}

function updateDashboard(walletAddress, walletData) {
  ui.walletAddress.textContent = walletAddress;
  ui.torrinoCount.textContent = String(walletData.gen1_count);
  ui.solnautaCount.textContent = String(walletData.gen2_count);
  ui.votingPower.textContent = formatVotingPower(walletData.voting_power);
  ui.proposalVotingPower.textContent = formatVotingPower(walletData.voting_power);

  renderNames(ui.torrinoNames, walletData.gen1_names, "Nessun Torrino DAO NFT trovato.");
  renderNames(ui.solnautaNames, walletData.gen2_names, "Nessun Solnauta NFT trovato.");
}

function updateResultsDashboard(results) {
  ui.solnautaVoted.textContent = String(results.solnauta_voted || 0);
  ui.torrinoVoted.textContent = String(results.torrino_voted || 0);
  ui.yesPower.textContent = formatVotingPower(results.yes_power);
  ui.noPower.textContent = formatVotingPower(results.no_power);
  ui.yesPercent.textContent = `${Number(results.yes_percent || 0)}%`;
  ui.noPercent.textContent = `${Number(results.no_percent || 0)}%`;
  ui.yesBar.style.width = `${Number(results.yes_percent || 0)}%`;
  ui.noBar.style.width = `${Number(results.no_percent || 0)}%`;
}

function renderNames(listElement, names, emptyMessage) {
  listElement.replaceChildren();

  if (!Array.isArray(names) || names.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "nft-list__empty";
    emptyItem.textContent = emptyMessage;
    listElement.appendChild(emptyItem);
    return;
  }

  for (const name of names) {
    const item = document.createElement("li");
    item.textContent = name;
    listElement.appendChild(item);
  }
}

function formatVotingPower(value) {
  return Number(value || 0).toFixed(1);
}

function setBusy(isBusy, message) {
  ui.connectButton.disabled = isBusy;
  ui.connectButton.textContent = isBusy
    ? "Connessione..."
    : "Collega Phantom Wallet";
  ui.yesButton.disabled = isBusy;
  ui.noButton.disabled = isBusy;

  if (message) {
    setStatus(message);
  }
}

function setVotingBusy(isBusy, message) {
  ui.yesButton.disabled = isBusy;
  ui.noButton.disabled = isBusy;
  ui.yesButton.textContent = isBusy ? "Invio..." : "SI";
  ui.noButton.textContent = isBusy ? "Invio..." : "NO";

  if (message) {
    setStatus(message);
  }
}

function setStatus(message) {
  ui.statusMessage.textContent = message;
}

function showVoteFeedback(message, type) {
  if (!ui.voteFeedback) {
    return;
  }

  if (state.voteFeedbackTimeoutId) {
    window.clearTimeout(state.voteFeedbackTimeoutId);
  }

  ui.voteFeedback.textContent = message;
  ui.voteFeedback.classList.remove("is-success", "is-error");
  ui.voteFeedback.classList.add("is-visible", type === "success" ? "is-success" : "is-error");

  state.voteFeedbackTimeoutId = window.setTimeout(() => {
    clearVoteFeedback();
  }, 5000);
}

function clearVoteFeedback() {
  if (!ui.voteFeedback) {
    return;
  }

  if (state.voteFeedbackTimeoutId) {
    window.clearTimeout(state.voteFeedbackTimeoutId);
    state.voteFeedbackTimeoutId = null;
  }

  ui.voteFeedback.textContent = "";
  ui.voteFeedback.classList.remove("is-visible", "is-success", "is-error");
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string") {
    if (error.message.includes("User rejected")) {
      return "La connessione del wallet e' stata annullata dall'utente.";
    }

    if (error.message === "NFT_ALREADY_VOTED") {
      return "Uno o piu' NFT risultano gia' utilizzati per il voto.";
    }

    if (error.message === "SERVER_ERROR") {
      return "Si e' verificato un errore durante la registrazione del voto.";
    }

    return error.message;
  }

  return "Si e' verificato un errore imprevisto durante la lettura dei dati del wallet.";
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

function bytesToBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return "";
  }

  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;

    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let result = "";

  for (const byte of bytes) {
    if (byte === 0) {
      result += alphabet[0];
      continue;
    }

    break;
  }

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    result += alphabet[digits[index]];
  }

  return result;
}
