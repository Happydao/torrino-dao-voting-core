const API_ENDPOINT = "/api/wallet-nfts";
const VOTE_ENDPOINT = "/api/vote";
const RESULTS_ENDPOINT = "/api/results";
const PROPOSAL_ENDPOINT = "/api/proposal";
const textEncoder = new TextEncoder();
const state = {
  walletAddress: null,
  walletData: null,
  proposal: null,
  voteFeedbackTimeoutId: null,
  resultsPollIntervalId: null,
  countdownIntervalId: null,
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
  proposalTag: document.getElementById("proposalTag"),
  proposalTitle: document.getElementById("proposalTitle"),
  proposalDescription: document.getElementById("proposalDescription"),
  proposalStatus: document.getElementById("proposalStatus"),
  proposalCountdown: document.getElementById("proposalCountdown"),
  voteOptions: document.getElementById("voteOptions"),
  voteFeedback: document.getElementById("voteFeedback"),
  resultsStatus: document.getElementById("resultsStatus"),
  solnautaVoted: document.getElementById("solnautaVoted"),
  torrinoVoted: document.getElementById("torrinoVoted"),
  totalPower: document.getElementById("totalPower"),
  resultsBars: document.getElementById("resultsBars"),
  securityModal: document.getElementById("securityModal"),
  openSecurityModal: document.getElementById("openSecurityModal"),
  closeSecurityModal: document.getElementById("closeSecurityModal"),
};

initializeWalletStatus();
initializeSecurityModal();
initializeProposalAndResults();
ui.connectButton.addEventListener("click", connectWallet);

async function initializeProposalAndResults() {
  await refreshProposal();
  await refreshResults();

  if (state.resultsPollIntervalId) {
    window.clearInterval(state.resultsPollIntervalId);
  }

  state.resultsPollIntervalId = window.setInterval(async () => {
    await refreshProposal();
    await refreshResults();
  }, 10000);
}

async function connectWallet() {
  const provider = getPhantomProvider();

  if (!provider) {
    setStatus(getMissingWalletMessage());
    return;
  }

  try {
    setConnectBusy(true, "Connessione a Phantom in corso...");
    const response = await window.solana.connect();
    const walletAddress = response.publicKey.toString();

    state.walletAddress = walletAddress;
    ui.walletAddress.textContent = walletAddress;
    setStatus("Wallet collegato. Lettura NFT dal backend in corso...");

    const walletData = await getWalletNfts(walletAddress);
    state.walletData = walletData;
    updateWalletDashboard(walletAddress, walletData);
    setStatus("NFT caricati correttamente. Puoi votare se la proposta e' attiva.");
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error));
  } finally {
    setConnectBusy(false);
    syncVoteButtons();
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
      setStatus(getPhantomProvider() ? "Phantom rilevato. Puoi collegare il wallet." : getMissingWalletMessage());
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

  return window.solana && window.solana.isPhantom ? window.solana : null;
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
    throw new Error(payload && payload.error ? payload.error : "SERVER_ERROR");
  }

  return payload;
}

async function refreshProposal() {
  try {
    const response = await fetch(PROPOSAL_ENDPOINT);
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      throw new Error("SERVER_ERROR");
    }

    state.proposal = payload && payload.proposal === null ? null : payload;
    renderProposal();
  } catch (error) {
    console.error(error);
  }
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

function renderProposal() {
  const proposal = state.proposal;

  if (!proposal) {
    ui.proposalTag.textContent = "Governance";
    ui.proposalTitle.textContent = "No active proposal";
    ui.proposalDescription.textContent = "L'admin non ha ancora avviato una votazione.";
    ui.proposalStatus.textContent = "Voting inactive";
    ui.proposalCountdown.textContent = "--";
    renderVoteOptions([]);
    stopCountdown();
    syncVoteButtons();
    return;
  }

  ui.proposalTag.textContent = proposal.proposal_id || "Governance";
  ui.proposalTitle.textContent = proposal.title;
  ui.proposalDescription.textContent = proposal.description;
  ui.proposalStatus.textContent = getProposalStatusLabel(proposal.status);
  renderVoteOptions(Array.isArray(proposal.options) ? proposal.options : []);
  startCountdown(proposal);
  syncVoteButtons();
}

function renderVoteOptions(options) {
  ui.voteOptions.replaceChildren();

  if (!options.length) {
    const empty = document.createElement("p");
    empty.className = "vote-options__empty";
    empty.textContent = "Nessuna opzione disponibile.";
    ui.voteOptions.appendChild(empty);
    return;
  }

  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vote-button vote-option-button";
    button.textContent = option;
    button.dataset.voteOption = option;
    button.addEventListener("click", () => submitVote(option));
    ui.voteOptions.appendChild(button);
  }
}

async function submitVote(voteOption) {
  const provider = getPhantomProvider();

  if (!provider || !state.walletAddress || !state.walletData) {
    setStatus("Collega prima il wallet per poter votare.");
    showVoteFeedback("An error occurred while submitting the vote.", "error");
    return;
  }

  if (!state.proposal || state.proposal.status !== "active") {
    setStatus("La votazione non e' attiva.");
    showVoteFeedback(state.proposal && state.proposal.status === "ended"
      ? "Voting has ended."
      : "An error occurred while submitting the vote.", "error");
    return;
  }

  if ((state.walletData.gen1_count + state.walletData.gen2_count) === 0) {
    setStatus("Il wallet collegato non possiede NFT validi per il voto.");
    showVoteFeedback("An error occurred while submitting the vote.", "error");
    return;
  }

  try {
    clearVoteFeedback();
    setVoteButtonsBusy(true);
    setStatus(`Invio voto "${voteOption}" in corso...`);
    const signature = await signVoteMessage(provider, voteOption);
    const response = await fetch(VOTE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: state.walletAddress,
        vote: voteOption,
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

    if (payload && payload.error === "ALL_NFTS_ALREADY_VOTED") {
      setStatus("Tutti gli NFT del wallet risultano gia' utilizzati per il voto.");
      showVoteFeedback(
        payload.message || "All NFTs from this wallet have already voted.",
        "error"
      );
      const walletData = await getWalletNfts(state.walletAddress);
      state.walletData = walletData;
      updateWalletDashboard(state.walletAddress, walletData);
      return;
    }

    if (payload && payload.error === "VOTING_ENDED") {
      setStatus("La votazione e' terminata.");
      showVoteFeedback("Voting has ended.", "error");
      await refreshProposal();
      return;
    }

    throw new Error(payload && payload.error ? payload.error : "SERVER_ERROR");
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error));
    showVoteFeedback("An error occurred while submitting the vote.", "error");
  } finally {
    setVoteButtonsBusy(false);
    syncVoteButtons();
  }
}

async function signVoteMessage(provider, voteOption) {
  if (typeof provider.signMessage !== "function") {
    return "not-signed";
  }

  const message = `Torrino DAO governance vote:${voteOption}:wallet:${state.walletAddress}:timestamp:${Date.now()}`;
  const signed = await provider.signMessage(textEncoder.encode(message), "utf8");

  return signed && signed.signature ? bytesToBase58(signed.signature) : "not-signed";
}

function updateWalletDashboard(walletAddress, walletData) {
  ui.walletAddress.textContent = walletAddress;
  ui.torrinoCount.textContent = String(walletData.gen1_count);
  ui.solnautaCount.textContent = String(walletData.gen2_count);
  ui.votingPower.textContent = formatVotingPower(walletData.voting_power);
  ui.proposalVotingPower.textContent = formatVotingPower(walletData.voting_power);
  renderNftStatusList(ui.torrinoNames, walletData.gen1_nfts, "Nessun Torrino DAO NFT trovato.");
  renderNftStatusList(ui.solnautaNames, walletData.gen2_nfts, "Nessun Solnauta NFT trovato.");
}

function updateResultsDashboard(results) {
  ui.resultsStatus.textContent = getProposalStatusLabel(results.status || "inactive");
  ui.solnautaVoted.textContent = String(results.solnauta_voted || 0);
  ui.torrinoVoted.textContent = String(results.torrino_voted || 0);
  ui.totalPower.textContent = formatVotingPower(results.total_power || 0);
  ui.resultsBars.replaceChildren();

  const optionResults = Array.isArray(results.option_results) ? results.option_results : [];

  if (optionResults.length === 0) {
    const empty = document.createElement("p");
    empty.className = "vote-options__empty";
    empty.textContent = "Nessun risultato disponibile.";
    ui.resultsBars.appendChild(empty);
    return;
  }

  for (const item of optionResults) {
    const row = document.createElement("div");
    row.className = "results-row";
    row.innerHTML = `
      <div class="results-row__meta">
        <span class="results-row__label">${escapeHtml(item.option)}</span>
        <strong>${formatVotingPower(item.power)} • ${Number(item.percent || 0)}%</strong>
      </div>
      <div class="results-track">
        <div class="results-fill" style="width: ${Number(item.percent || 0)}%"></div>
      </div>
    `;
    ui.resultsBars.appendChild(row);
  }
}

function renderNftStatusList(listElement, nfts, emptyMessage) {
  listElement.replaceChildren();

  if (!Array.isArray(nfts) || nfts.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "nft-list__empty";
    emptyItem.textContent = emptyMessage;
    listElement.appendChild(emptyItem);
    return;
  }

  for (const nft of nfts) {
    const item = document.createElement("li");
    item.className = nft.status === "USED"
      ? "nft-list__item nft-list__item--used"
      : "nft-list__item nft-list__item--available";
    item.textContent = `${nft.name} (${nft.status})`;
    listElement.appendChild(item);
  }
}

function startCountdown(proposal) {
  stopCountdown();
  updateCountdown(proposal);
  state.countdownIntervalId = window.setInterval(() => {
    updateCountdown(proposal);
  }, 1000);
}

function stopCountdown() {
  if (state.countdownIntervalId) {
    window.clearInterval(state.countdownIntervalId);
    state.countdownIntervalId = null;
  }
}

function updateCountdown(proposal) {
  const now = Math.floor(Date.now() / 1000);
  const currentStatus = now < proposal.start_time ? "scheduled" : now > proposal.end_time ? "ended" : "active";
  const target = currentStatus === "scheduled" ? proposal.start_time : proposal.end_time;
  const diff = Math.max(target - now, 0);

  if (currentStatus === "ended") {
    ui.proposalCountdown.textContent = "Voting has ended.";
    state.proposal = { ...proposal, status: "ended" };
    ui.proposalStatus.textContent = getProposalStatusLabel("ended");
    syncVoteButtons();
    stopCountdown();
    return;
  }

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  state.proposal = { ...proposal, status: currentStatus };
  ui.proposalStatus.textContent = getProposalStatusLabel(currentStatus);
  const prefix = currentStatus === "scheduled" ? "Starts in" : "Ends in";
  ui.proposalCountdown.textContent = `${prefix} ${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function syncVoteButtons() {
  const buttons = ui.voteOptions.querySelectorAll("button");
  const shouldDisable = !state.proposal || state.proposal.status !== "active";

  buttons.forEach((button) => {
    button.disabled = shouldDisable;
  });

  if (shouldDisable && state.proposal && state.proposal.status === "ended") {
    ui.voteFeedback.textContent = "Voting has ended.";
    ui.voteFeedback.classList.add("is-visible", "is-error");
  }
}

function setConnectBusy(isBusy, message) {
  ui.connectButton.disabled = isBusy;
  ui.connectButton.textContent = isBusy ? "Connessione..." : "Collega Phantom Wallet";

  if (message) {
    setStatus(message);
  }
}

function setVoteButtonsBusy(isBusy) {
  const buttons = ui.voteOptions.querySelectorAll("button");

  buttons.forEach((button) => {
    button.disabled = isBusy;
    button.textContent = isBusy
      ? "Invio..."
      : button.dataset.voteOption;
  });
}

function setStatus(message) {
  ui.statusMessage.textContent = message;
}

function showVoteFeedback(message, type) {
  if (state.voteFeedbackTimeoutId) {
    window.clearTimeout(state.voteFeedbackTimeoutId);
  }

  ui.voteFeedback.textContent = message;
  ui.voteFeedback.classList.remove("is-success", "is-error");
  ui.voteFeedback.classList.add("is-visible", type === "success" ? "is-success" : "is-error");
  state.voteFeedbackTimeoutId = window.setTimeout(clearVoteFeedback, 5000);
}

function clearVoteFeedback() {
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
      return "La firma del wallet e' stata annullata dall'utente.";
    }

    if (error.message === "VOTING_ENDED") {
      return "La votazione e' terminata.";
    }

    return "Si e' verificato un errore durante la registrazione del voto.";
  }

  return "Si e' verificato un errore durante la registrazione del voto.";
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

function formatVotingPower(value) {
  return Number(value || 0).toFixed(1);
}

function getProposalStatusLabel(status) {
  if (status === "active") {
    return "Voting active";
  }

  if (status === "scheduled") {
    return "Voting scheduled";
  }

  if (status === "ended") {
    return "Voting has ended";
  }

  return "Voting inactive";
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
