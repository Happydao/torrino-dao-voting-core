const APP_BASE_PATH = "/torrino.dao.voting";
const API_BASE_PATH = `${APP_BASE_PATH}/api`;
const API_ENDPOINT = `${API_BASE_PATH}/wallet-nfts`;
const VOTE_ENDPOINT = `${API_BASE_PATH}/vote`;
const RESULTS_ENDPOINT = `${API_BASE_PATH}/results`;
const PROPOSAL_ENDPOINT = `${API_BASE_PATH}/proposal`;
const GOVERNANCE_HISTORY_API = "https://api.github.com/repos/Happydao/torrino-dao-voting-core/contents/data";
const GOVERNANCE_HISTORY_RAW_BASE = "https://raw.githubusercontent.com/Happydao/torrino-dao-voting-core/main/data/";
const textEncoder = new TextEncoder();
const state = {
  walletAddress: null,
  walletData: null,
  proposal: null,
  voteFeedbackTimeoutId: null,
  resultsPollIntervalId: null,
  countdownIntervalId: null,
  governanceHistory: [],
  governanceHistoryLoaded: false,
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
  historyModal: document.getElementById("historyModal"),
  openHistoryModal: document.getElementById("openHistoryModal"),
  closeHistoryModal: document.getElementById("closeHistoryModal"),
  historyTableBody: document.getElementById("historyTableBody"),
};

initializeWalletStatus();
initializeHistoryModal();
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
  const provider = getWalletProvider();

  if (!provider) {
    setStatus(getMissingWalletMessage());
    return;
  }

  try {
    setConnectBusy(true, "Connessione wallet in corso...");
    const walletAddress = await connectWalletProvider(provider);

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
  if (getWalletProvider()) {
    setStatus("Wallet compatibile rilevato. Puoi collegare Phantom o Solflare.");
    return;
  }

  setStatus("In attesa di Phantom o Solflare...");

  window.addEventListener("load", () => {
    window.setTimeout(() => {
      setStatus(
        getWalletProvider()
          ? "Wallet compatibile rilevato. Puoi collegare Phantom o Solflare."
          : getMissingWalletMessage()
      );
    }, 600);
  });
}

function getWalletProvider() {
  const providers = getInstalledWalletProviders();
  const connectedProvider = providers.find((provider) => provider && provider.isConnected);

  if (connectedProvider) {
    return connectedProvider;
  }

  return providers[0] || null;
}

function getInstalledWalletProviders() {
  const providers = [];
  const knownProviders = [
    window.phantom && window.phantom.solana,
    window.solflare,
    window.solana,
  ];

  if (window.solana && Array.isArray(window.solana.providers)) {
    knownProviders.push(...window.solana.providers);
  }

  for (const provider of knownProviders) {
    if (
      !provider ||
      typeof provider.connect !== "function" ||
      (!provider.isPhantom && !provider.isSolflare)
    ) {
      continue;
    }

    if (!providers.includes(provider)) {
      providers.push(provider);
    }
  }

  providers.sort((left, right) => {
    if (left.isConnected && !right.isConnected) {
      return -1;
    }

    if (!left.isConnected && right.isConnected) {
      return 1;
    }

    if (left.isPhantom && !right.isPhantom) {
      return -1;
    }

    if (!left.isPhantom && right.isPhantom) {
      return 1;
    }

    return 0;
  });

  return providers;
}

async function connectWalletProvider(provider) {
  const response = await provider.connect({ onlyIfTrusted: false });
  const publicKey = response && response.publicKey ? response.publicKey : provider.publicKey;

  if (!publicKey || typeof publicKey.toString !== "function") {
    throw new Error("WALLET_CONNECTION_UNAVAILABLE");
  }

  return publicKey.toString();
}

function getMissingWalletMessage() {
  if (getInstalledWalletProviders().length > 0 || window.solana || window.solflare) {
    return "E' stato rilevato un wallet Solana, ma Phantom o Solflare non sono disponibili come provider attivi.";
  }

  return "Phantom o Solflare non sono stati rilevati in questo browser.";
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
    button.className = `vote-button vote-option-button vote-option-button--${getOptionColorName(
      ui.voteOptions.childElementCount
    )}`;
    button.textContent = option;
    button.dataset.voteOption = option;
    button.dataset.colorName = getOptionColorName(ui.voteOptions.childElementCount);
    button.addEventListener("click", () => submitVote(option));
    ui.voteOptions.appendChild(button);
  }
}

async function submitVote(voteOption) {
  const provider = getWalletProvider();

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
    const signedVote = await signVoteMessage(provider, voteOption);
    const response = await fetch(VOTE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: state.walletAddress,
        vote: voteOption,
        signature: signedVote.signature,
        signed_message: signedVote.message,
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
    throw new Error("SIGNATURE_UNAVAILABLE");
  }

  const message = `Torrino DAO governance vote:${voteOption}:wallet:${state.walletAddress}:timestamp:${Date.now()}`;
  const signed = await provider.signMessage(textEncoder.encode(message), "utf8");
  const signatureBytes = extractSignatureBytes(signed);

  if (!signatureBytes) {
    throw new Error("SIGNATURE_UNAVAILABLE");
  }

  return {
    message,
    signature: bytesToBase58(signatureBytes),
  };
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
    const colorName = getOptionColorName(ui.resultsBars.childElementCount);
    const row = document.createElement("div");
    row.className = "results-row";
    row.innerHTML = `
      <div class="results-row__meta">
        <span class="results-row__label results-row__label--${colorName}">${escapeHtml(item.option)}</span>
        <strong>${formatVotingPower(item.power)} • ${Number(item.percent || 0)}%</strong>
      </div>
      <div class="results-track">
        <div class="results-fill results-fill--${colorName}" style="width: ${Number(item.percent || 0)}%"></div>
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
    const link = document.createElement("a");
    link.href = getSolscanTokenUrl(nft.mint);
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "nft-list__link";
    link.textContent = shortMint(nft.mint);

    const statusText = document.createElement("span");
    statusText.className = "nft-list__status";
    statusText.textContent = ` (${nft.status})`;

    item.appendChild(link);
    item.appendChild(statusText);
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
  ui.connectButton.textContent = isBusy ? "Connessione..." : "Collega Wallet";

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

    if (error.message === "SIGNATURE_UNAVAILABLE") {
      return "Il wallet collegato non supporta la firma richiesta per confermare il voto.";
    }

    if (error.message === "VOTING_ENDED") {
      return "La votazione e' terminata.";
    }

    if (error.message === "INVALID_WALLET_SIGNATURE") {
      return "La firma del wallet non e' valida per questo voto.";
    }

    return "Si e' verificato un errore durante la registrazione del voto.";
  }

  return "Si e' verificato un errore durante la registrazione del voto.";
}

function initializeHistoryModal() {
  if (!ui.historyModal || !ui.openHistoryModal || !ui.closeHistoryModal) {
    return;
  }

  ui.openHistoryModal.addEventListener("click", async () => {
    ui.historyModal.classList.add("open");
    ui.historyModal.setAttribute("aria-hidden", "false");
    ui.openHistoryModal.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    if (!state.governanceHistoryLoaded) {
      await loadGovernanceHistory();
    }
  });

  ui.closeHistoryModal.addEventListener("click", closeHistoryModal);

  ui.historyModal.addEventListener("click", (event) => {
    if (event.target === ui.historyModal) {
      closeHistoryModal();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.historyModal.classList.contains("open")) {
      closeHistoryModal();
    }
  });
}

async function loadGovernanceHistory() {
  renderGovernanceHistoryRows([], "Loading governance history...");

  try {
    const response = await fetch(GOVERNANCE_HISTORY_API, {
      headers: { accept: "application/vnd.github+json" },
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !Array.isArray(payload)) {
      throw new Error("GOVERNANCE_HISTORY_UNAVAILABLE");
    }

    state.governanceHistory = payload
      .filter((item) => item && item.type === "file" && /^proposal_(\d+)\.csv$/.test(item.name))
      .map((item) => {
        const match = item.name.match(/^proposal_(\d+)\.csv$/);
        const timestamp = match ? Number(match[1]) : NaN;
        return {
          name: item.name,
          timestamp,
          dateLabel: formatHistoryDate(timestamp),
          downloadUrl: `${GOVERNANCE_HISTORY_RAW_BASE}${item.name}`,
        };
      })
      .sort((first, second) => second.timestamp - first.timestamp);

    state.governanceHistoryLoaded = true;
    renderGovernanceHistoryRows(state.governanceHistory);
  } catch (error) {
    console.error(error);
    renderGovernanceHistoryRows([], "Unable to load governance history.");
  }
}

function renderGovernanceHistoryRows(items, emptyMessage = "No governance history found.") {
  ui.historyTableBody.replaceChildren();

  if (!Array.isArray(items) || items.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="3" class="history-table__empty">${escapeHtml(emptyMessage)}</td>`;
    ui.historyTableBody.appendChild(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.className = "mono";
    nameCell.textContent = item.name;

    const dateCell = document.createElement("td");
    dateCell.textContent = item.dateLabel;

    const actionCell = document.createElement("td");
    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "chip chip--ghost";
    downloadButton.textContent = "Download CSV";
    downloadButton.addEventListener("click", () => {
      downloadGovernanceCsv(item.downloadUrl, item.name).catch((error) => {
        console.error(error);
      });
    });

    actionCell.appendChild(downloadButton);
    row.appendChild(nameCell);
    row.appendChild(dateCell);
    row.appendChild(actionCell);
    ui.historyTableBody.appendChild(row);
  }
}

async function downloadGovernanceCsv(csvUrl, filename) {
  const response = await fetch(csvUrl);

  if (!response.ok) {
    throw new Error("CSV_DOWNLOAD_FAILED");
  }

  const csvBlob = await response.blob();
  const objectUrl = URL.createObjectURL(csvBlob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

function closeHistoryModal() {
  ui.historyModal.classList.remove("open");
  ui.historyModal.setAttribute("aria-hidden", "true");
  ui.openHistoryModal.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}

function getOptionColorName(index) {
  const colorOrder = ["green", "red", "blue", "purple", "orange"];
  return colorOrder[index] || colorOrder[colorOrder.length - 1];
}

function formatHistoryDate(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "--";
  }

  return new Date(timestamp * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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

function extractSignatureBytes(signedValue) {
  if (!signedValue) {
    return null;
  }

  if (signedValue instanceof Uint8Array) {
    return signedValue;
  }

  if (signedValue.signature instanceof Uint8Array) {
    return signedValue.signature;
  }

  if (Array.isArray(signedValue.signature)) {
    return Uint8Array.from(signedValue.signature);
  }

  return null;
}

function shortMint(mint) {
  if (typeof mint !== "string" || mint.length <= 8) {
    return mint || "";
  }

  return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function getSolscanTokenUrl(mint) {
  return `https://solscan.io/token/${mint}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
