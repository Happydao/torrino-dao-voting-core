const APP_BASE_PATH = "/torrino.dao.voting";
const API_BASE_PATH = `${APP_BASE_PATH}/api`;
const API_ENDPOINT = `${API_BASE_PATH}/wallet-nfts`;
const VOTE_ENDPOINT = `${API_BASE_PATH}/vote`;
const RESULTS_ENDPOINT = `${API_BASE_PATH}/results`;
const PROPOSAL_ENDPOINT = `${API_BASE_PATH}/proposal`;
const TORRINO_TOTAL_NFTS = 500;
const SOLNAUTA_TOTAL_NFTS = 888;
const TOTAL_VOTING_POWER = 100;
const GOVERNANCE_HISTORY_API = "https://api.github.com/repos/Happydao/torrino-dao-voting-core/contents/data";
const GOVERNANCE_HISTORY_RAW_BASE = "https://raw.githubusercontent.com/Happydao/torrino-dao-voting-core/main/data/";
const textEncoder = new TextEncoder();

const state = {
  walletAddress: null,
  walletProvider: null,
  walletData: null,
  proposals: [],
  proposalStatus: "inactive",
  results: [],
  resultsPollIntervalId: null,
  countdownIntervalId: null,
  governanceHistory: [],
  governanceHistoryLoaded: false,
  votingProposalId: "",
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
  proposalCards: document.getElementById("proposalCards"),
  resultsCards: document.getElementById("resultsCards"),
  voteFeedback: document.getElementById("voteFeedback"),
  feedbackModal: document.getElementById("feedbackModal"),
  feedbackModalBadge: document.getElementById("feedbackModalBadge"),
  feedbackModalTitle: document.getElementById("feedbackModalTitle"),
  feedbackModalMessage: document.getElementById("feedbackModalMessage"),
  closeFeedbackModal: document.getElementById("closeFeedbackModal"),
  historyModal: document.getElementById("historyModal"),
  openHistoryModal: document.getElementById("openHistoryModal"),
  closeHistoryModal: document.getElementById("closeHistoryModal"),
  historyTableBody: document.getElementById("historyTableBody"),
};

initializeWalletStatus();
initializeHistoryModal();
initializeFeedbackModal();
initializeProposalAndResults();
ui.connectButton.addEventListener("click", handleWalletButtonClick);

async function handleWalletButtonClick() {
  if (state.walletAddress && state.walletProvider) {
    await disconnectWallet();
    return;
  }

  await connectWallet();
}

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
    setConnectBusy(true, "Connecting wallet...");
    const walletAddress = await connectWalletProvider(provider);

    state.walletAddress = walletAddress;
    state.walletProvider = provider;
    ui.walletAddress.textContent = walletAddress;
    setStatus("Wallet connected. Loading NFTs from the backend...");

    const walletData = await getWalletNfts(walletAddress);
    state.walletData = walletData;
    updateWalletDashboard(walletAddress, walletData);
    renderProposalCards();
    setStatus("NFTs loaded successfully. You can vote on every active proposal separately.");
  } catch (error) {
    console.error(error);
    setStatus(getErrorMessage(error));
  } finally {
    setConnectBusy(false);
    syncProposalButtons();
  }
}

async function disconnectWallet() {
  const provider = state.walletProvider;

  try {
    setConnectBusy(true, "Disconnecting wallet...");
    await disconnectWalletProvider(provider);
  } catch (error) {
    console.error(error);
  } finally {
    clearWalletSession();
    setConnectBusy(false);
    syncProposalButtons();
  }
}

function initializeWalletStatus() {
  updateConnectButtonLabel();

  if (getWalletProvider()) {
    setStatus("Compatible wallet detected. You can connect Phantom or Solflare.");
    return;
  }

  setStatus("Waiting for Phantom or Solflare...");

  window.addEventListener("load", () => {
    window.setTimeout(() => {
      setStatus(
        getWalletProvider()
          ? "Compatible wallet detected. You can connect Phantom or Solflare."
          : getMissingWalletMessage()
      );
    }, 600);
  });
}

function getWalletProvider() {
  const providers = getInstalledWalletProviders();
  const connectedProvider = providers.find((provider) => provider && provider.isConnected);
  return connectedProvider || providers[0] || null;
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

async function disconnectWalletProvider(provider) {
  if (provider && typeof provider.disconnect === "function") {
    await provider.disconnect();
  }
}

function getMissingWalletMessage() {
  if (getInstalledWalletProviders().length > 0 || window.solana || window.solflare) {
    return "A Solana wallet was detected, but Phantom or Solflare are not available as active providers.";
  }

  return "Phantom or Solflare were not detected in this browser.";
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

    state.proposals = Array.isArray(payload.proposals) ? payload.proposals : [];
    state.proposalStatus = payload.status || "inactive";
    renderProposalCards();
    startCountdownLoop();
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

    state.results = Array.isArray(payload.results) ? payload.results : [];
    renderResultsCards();
  } catch (error) {
    console.error(error);
  }
}

function renderProposalCards() {
  ui.proposalCards.replaceChildren();

  if (state.proposals.length === 0) {
    const empty = document.createElement("section");
    empty.className = "proposal-card proposal-card--featured proposal-empty-card";
    empty.innerHTML = `
      <p class="proposal-tag">PROPOSAL</p>
      <h2>No active proposal</h2>
      <p class="proposal-copy">The admin has not started a vote yet.</p>
    `;
    ui.proposalCards.appendChild(empty);
    syncProposalButtons();
    return;
  }

  for (const proposal of state.proposals) {
    const proposalState = getWalletProposalState(proposal.proposal_id);
    const proposalFileName = proposal.csv_file_name || `${proposal.display_name || proposal.proposal_name || `proposal_${proposal.proposal_id}`}.csv`;
    const proposalTitle = String(proposal.title || "").trim();
    const shouldShowTitle = proposalTitle && proposalTitle !== proposal.display_name && proposalTitle !== proposal.proposal_name;
    const card = document.createElement("section");
    card.className = "proposal-card proposal-card--featured proposal-card--slot";
    card.dataset.proposalId = proposal.proposal_id;
    card.innerHTML = `
      <p class="proposal-tag">${escapeHtml(proposalFileName)}</p>
      ${shouldShowTitle ? `<p class="proposal-copy proposal-copy--title">${escapeHtml(proposalTitle)}</p>` : ""}
      <p class="proposal-copy">${escapeHtml(proposal.description || "")}</p>
      <div class="proposal-details">
        <div class="proposal-detail">
          <span>Your available voting power</span>
          <strong>${formatVotingPower(proposalState ? proposalState.voting_power : 0)}</strong>
        </div>
        <div class="proposal-detail">
          <span>Voting status</span>
          <strong class="proposal-state" data-role="status">${getProposalStatusLabel(proposal.status)}</strong>
        </div>
        <div class="proposal-detail proposal-detail--countdown">
          <span>Countdown</span>
          <strong data-role="countdown">${getProposalCountdownLabel(proposal)}</strong>
        </div>
      </div>
      <div class="proposal-card__footer">
        <p class="proposal-card__note">
          ${proposalState
            ? `Wallet-confirmed voting power for this proposal: ${formatVotingPower(proposalState.voting_power)}`
            : "Connect a wallet to see your proposal-specific voting power."}
        </p>
      </div>
      <div class="vote-options"></div>
    `;

    const optionsContainer = card.querySelector(".vote-options");
    renderVoteOptions(optionsContainer, proposal);
    ui.proposalCards.appendChild(card);
  }

  syncProposalButtons();
}

function renderVoteOptions(container, proposal) {
  container.replaceChildren();
  const options = Array.isArray(proposal.options) ? proposal.options : [];

  if (options.length === 0) {
    const empty = document.createElement("p");
    empty.className = "vote-options__empty";
    empty.textContent = "No options available.";
    container.appendChild(empty);
    return;
  }

  for (const option of options) {
    const button = document.createElement("button");
    const colorName = getOptionColorName(container.childElementCount);
    button.type = "button";
    button.className = `vote-button vote-option-button vote-option-button--${colorName}`;
    button.textContent = option;
    button.dataset.voteOption = option;
    button.dataset.proposalId = proposal.proposal_id;
    button.dataset.colorName = colorName;
    button.addEventListener("click", () => submitVote(proposal.proposal_id, option));
    container.appendChild(button);
  }
}

async function submitVote(proposalId, voteOption) {
  const provider = state.walletProvider || getWalletProvider();
  const proposal = state.proposals.find((item) => item.proposal_id === proposalId);
  const proposalFileName = getProposalFileNameById(proposalId);

  if (!provider || !state.walletAddress || !state.walletData) {
    setStatus("Connect your wallet before voting.");
    showVoteFeedback("Connect your wallet before voting.", "error");
    return;
  }

  if (!proposal || proposal.status !== "active") {
    setStatus("Voting is not active for this proposal.");
    showVoteFeedback(
      proposal && proposal.status === "ended"
        ? "Voting has ended for this proposal."
        : "Voting is not active for this proposal.",
      "error"
    );
    return;
  }

  const proposalState = getWalletProposalState(proposalId);

  if (!proposalState || (proposalState.gen1_available_count + proposalState.gen2_available_count) === 0) {
    setStatus(`All NFTs from this wallet are already used in ${proposalFileName}.`);
    showVoteFeedback(`All NFTs from this wallet are already used in ${proposalFileName}.`, "error");
    return;
  }

  try {
    clearVoteFeedback();
    state.votingProposalId = proposalId;
    setVoteButtonsBusy(true);
    setStatus(`Submitting vote "${voteOption}" for ${proposalFileName}...`);
    const signedVote = await signVoteMessage(provider, proposal, voteOption);
    const response = await fetch(VOTE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposal_id: proposalId,
        wallet: state.walletAddress,
        vote: voteOption,
        signature: signedVote.signature,
        signed_message: signedVote.message,
      }),
    });
    const payload = await response.json().catch(() => null);

    if (response.ok && payload && payload.success === true) {
      setStatus(`Vote recorded for ${proposalFileName}. Voting power used: ${formatVotingPower(payload.voting_power)}.`);
      showVoteFeedback(`Vote for ${proposalFileName} successfully recorded.`, "success");
      const walletData = await getWalletNfts(state.walletAddress);
      state.walletData = walletData;
      updateWalletDashboard(state.walletAddress, walletData);
      await refreshProposal();
      await refreshResults();
      return;
    }

    if (payload && payload.error === "ALL_NFTS_ALREADY_VOTED") {
      setStatus(`All NFTs from this wallet have already been used in ${proposalFileName}.`);
      showVoteFeedback(
        payload.message || `All NFTs from this wallet have already been used in ${proposalFileName}.`,
        "error"
      );
      const walletData = await getWalletNfts(state.walletAddress);
      state.walletData = walletData;
      updateWalletDashboard(state.walletAddress, walletData);
      renderProposalCards();
      return;
    }

    if (payload && payload.error === "VOTING_ENDED") {
      setStatus(`Voting has ended for ${proposalFileName}.`);
      showVoteFeedback(`Voting has ended for ${proposalFileName}.`, "error");
      await refreshProposal();
      return;
    }

    if (payload && payload.error === "VOTING_NOT_STARTED") {
      setStatus(`Voting has not started yet for ${proposalFileName}.`);
      showVoteFeedback(`Voting has not started yet for ${proposalFileName}.`, "error");
      await refreshProposal();
      return;
    }

    throw new Error(payload && payload.error ? payload.error : "SERVER_ERROR");
  } catch (error) {
    console.error(error);
    const errorMessage = getErrorMessage(error);
    setStatus(errorMessage);
    showVoteFeedback(errorMessage, "error");
  } finally {
    state.votingProposalId = "";
    setVoteButtonsBusy(false);
    syncProposalButtons();
  }
}

async function signVoteMessage(provider, proposal, voteOption) {
  if (typeof provider.signMessage !== "function") {
    throw new Error("SIGNATURE_UNAVAILABLE");
  }

  const proposalFileName = getProposalFileNameById(proposal.proposal_id);
  const proposalPayloadHash = await hashProposalPayload(proposal);
  const message = `Torrino DAO governance vote:proposal:${proposalFileName}:proposal_hash:${proposalPayloadHash}:option:${voteOption}:wallet:${state.walletAddress}:timestamp:${Date.now()}`;
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
  renderNftStatusList(ui.torrinoNames, walletData.gen1_nfts, "No Torrino DAO NFTs found.");
  renderNftStatusList(ui.solnautaNames, walletData.gen2_nfts, "No Solnauta NFTs found.");
}

function clearWalletSession() {
  state.walletAddress = null;
  state.walletProvider = null;
  state.walletData = null;
  ui.walletAddress.textContent = "Not connected";
  ui.torrinoCount.textContent = "0";
  ui.solnautaCount.textContent = "0";
  ui.votingPower.textContent = "0.0";
  renderNftStatusList(ui.torrinoNames, [], "No Torrino DAO NFTs found.");
  renderNftStatusList(ui.solnautaNames, [], "No Solnauta NFTs found.");
  clearVoteFeedback();
  setStatus("Wallet disconnected.");
  renderProposalCards();
}

function renderResultsCards() {
  ui.resultsCards.replaceChildren();

  if (!Array.isArray(state.results) || state.results.length === 0) {
    const empty = document.createElement("section");
    empty.className = "results-card";
    empty.innerHTML = `
      <div class="results-header">
        <p class="proposal-tag">Live Voting Results</p>
        <h2>No results available</h2>
        <p class="results-status">Voting inactive</p>
      </div>
      <p class="proposal-copy">Results will appear here as soon as at least one proposal is created.</p>
    `;
    ui.resultsCards.appendChild(empty);
    return;
  }

  for (const results of state.results) {
    const liveProposal = state.proposals.find((item) => item.proposal_id === results.proposal_id);
    const liveStatus = liveProposal ? liveProposal.status : (results.status || "inactive");
    const proposalFileName = (liveProposal && liveProposal.csv_file_name) || results.csv_file_name || `${results.display_name || `proposal_${results.proposal_id || "--"}`}.csv`;
    const card = document.createElement("section");
    card.className = "results-card";
    card.innerHTML = `
      <div class="results-header">
        <p class="results-overline">Live Voting Results</p>
        <h2>${escapeHtml(proposalFileName)}</h2>
        <p class="results-status">${getProposalStatusLabel(liveStatus)}</p>
      </div>
      <div class="results-grid">
        <article class="results-stat">
          <span class="label">Torrino DAO NFTs voted</span>
          <strong>${escapeHtml(String(results.torrino_voted || 0))}</strong>
          <span class="results-stat__detail">${formatParticipationRate(results.torrino_voted, TORRINO_TOTAL_NFTS)} of ${TORRINO_TOTAL_NFTS} collection NFTs</span>
        </article>
        <article class="results-stat">
          <span class="label">Solnauta NFTs voted</span>
          <strong>${escapeHtml(String(results.solnauta_voted || 0))}</strong>
          <span class="results-stat__detail">${formatParticipationRate(results.solnauta_voted, SOLNAUTA_TOTAL_NFTS)} of ${SOLNAUTA_TOTAL_NFTS} collection NFTs</span>
        </article>
        <article class="results-stat results-stat--yes">
          <span class="label">Total Voting Power</span>
          <strong>${formatVotingPower(results.total_power || 0)}</strong>
          <span class="results-stat__detail">Participation rate: ${formatParticipationRate(results.total_power, TOTAL_VOTING_POWER)} of ${TOTAL_VOTING_POWER.toFixed(1)} total power</span>
        </article>
      </div>
      <div class="results-bars"></div>
    `;

    const bars = card.querySelector(".results-bars");
    renderResultsBars(bars, results);
    ui.resultsCards.appendChild(card);
  }
}

function renderResultsBars(container, results) {
  container.replaceChildren();
  const optionResults = Array.isArray(results.option_results) ? results.option_results : [];

  if (optionResults.length === 0) {
    const empty = document.createElement("p");
    empty.className = "vote-options__empty";
    empty.textContent = "No results available.";
    container.appendChild(empty);
    return;
  }

  for (const item of optionResults) {
    const colorName = getOptionColorName(container.childElementCount);
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
    container.appendChild(row);
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
    item.className = getNftStatusClassName(nft.status);
    const link = document.createElement("a");
    link.href = getSolscanTokenUrl(nft.mint);
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "nft-list__link";
    link.textContent = shortMint(nft.mint);

    const statusText = document.createElement("span");
    statusText.className = "nft-list__status";
    statusText.textContent = ` (${nft.status})`;

    item.append(link, statusText);
    listElement.appendChild(item);
  }
}

function getNftStatusClassName(status) {
  if (status === "AVAILABLE") {
    return "nft-list__item nft-list__item--available";
  }

  if (String(status).startsWith("USED IN PROPOSALS")) {
    return "nft-list__item nft-list__item--used-all";
  }

  if (String(status).startsWith("USED IN PROPOSAL")) {
    return "nft-list__item nft-list__item--used-partial";
  }

  return "nft-list__item nft-list__item--used";
}

function startCountdownLoop() {
  if (state.countdownIntervalId) {
    return;
  }

  state.countdownIntervalId = window.setInterval(() => {
    updateProposalCountdowns();
  }, 1000);
  updateProposalCountdowns();
}

function updateProposalCountdowns() {
  if (!Array.isArray(state.proposals) || state.proposals.length === 0) {
    return;
  }

  let hasChanged = false;

  for (const proposal of state.proposals) {
    const nextStatus = getLiveProposalStatus(proposal);
    if (proposal.status !== nextStatus) {
      proposal.status = nextStatus;
      hasChanged = true;
    }
  }

  for (const card of ui.proposalCards.querySelectorAll("[data-proposal-id]")) {
    const proposal = state.proposals.find((item) => item.proposal_id === card.dataset.proposalId);
    if (!proposal) {
      continue;
    }

    const statusNode = card.querySelector('[data-role="status"]');
    const countdownNode = card.querySelector('[data-role="countdown"]');

    if (statusNode) {
      statusNode.textContent = getProposalStatusLabel(proposal.status);
    }

    if (countdownNode) {
      countdownNode.textContent = getProposalCountdownLabel(proposal);
    }
  }

  if (hasChanged) {
    syncProposalButtons();
    renderResultsCards();
  } else {
    syncProposalButtons();
  }
}

function getLiveProposalStatus(proposal) {
  const now = Math.floor(Date.now() / 1000);

  if (now < Number(proposal.start_time)) {
    return "scheduled";
  }

  if (now >= Number(proposal.end_time)) {
    return "ended";
  }

  return "active";
}

function getProposalCountdownLabel(proposal) {
  const status = getLiveProposalStatus(proposal);

  if (status === "ended") {
    return "Voting has ended.";
  }

  const target = status === "scheduled" ? Number(proposal.start_time) : Number(proposal.end_time);
  const diff = Math.max(target - Math.floor(Date.now() / 1000), 0);
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  const prefix = status === "scheduled" ? "Starts in" : "Ends in";

  return `${prefix} ${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function syncProposalButtons() {
  const buttons = ui.proposalCards.querySelectorAll(".vote-option-button");

  buttons.forEach((button) => {
    const proposal = state.proposals.find((item) => item.proposal_id === button.dataset.proposalId);
    const proposalState = getWalletProposalState(button.dataset.proposalId);
    const noAvailablePower = !proposalState || Number(proposalState.voting_power || 0) <= 0;
    const shouldDisable = (
      !state.walletAddress ||
      !proposal ||
      proposal.status !== "active" ||
      state.votingProposalId !== "" ||
      noAvailablePower
    );

    button.disabled = shouldDisable;
  });
}

function setConnectBusy(isBusy, message) {
  ui.connectButton.disabled = isBusy;
  ui.connectButton.textContent = isBusy
    ? state.walletAddress
      ? "Disconnecting..."
      : "Connecting..."
    : getConnectButtonLabel();

  if (message) {
    setStatus(message);
  }
}

function updateConnectButtonLabel() {
  ui.connectButton.textContent = getConnectButtonLabel();
}

function getConnectButtonLabel() {
  return state.walletAddress ? "Disconnect Wallet" : "Connect Wallet";
}

function setVoteButtonsBusy(isBusy) {
  const buttons = ui.proposalCards.querySelectorAll(".vote-option-button");

  buttons.forEach((button) => {
    const isCurrentProposal = button.dataset.proposalId === state.votingProposalId;
    button.disabled = isBusy || button.disabled;
    button.textContent = isBusy && isCurrentProposal
      ? "Submitting..."
      : button.dataset.voteOption;
  });
}

function setStatus(message) {
  ui.statusMessage.textContent = message;
}

function showVoteFeedback(message, type) {
  ui.voteFeedback.textContent = message;
  ui.voteFeedback.classList.remove("is-success", "is-error");
  ui.voteFeedback.classList.add("is-visible", type === "success" ? "is-success" : "is-error");
  openFeedbackModal(type === "success" ? "Vote Confirmed" : "Vote Error", message, type);
}

function clearVoteFeedback() {
  ui.voteFeedback.textContent = "";
  ui.voteFeedback.classList.remove("is-visible", "is-success", "is-error");
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string") {
    if (error.message.includes("User rejected")) {
      return "The wallet signature was cancelled by the user.";
    }

    if (error.message === "SIGNATURE_UNAVAILABLE") {
      return "Hardware wallet message signing not supported.";
    }

    if (error.message === "VOTING_ENDED") {
      return "Voting has ended for this proposal.";
    }

    if (error.message === "VOTING_NOT_STARTED") {
      return "Voting has not started yet for this proposal.";
    }

    if (error.message === "INVALID_WALLET_SIGNATURE") {
      return "The wallet signature is not valid for this vote.";
    }

    return "An error occurred while recording the vote.";
  }

  return "An error occurred while recording the vote.";
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

function initializeFeedbackModal() {
  if (!ui.feedbackModal || !ui.closeFeedbackModal) {
    return;
  }

  ui.closeFeedbackModal.addEventListener("click", closeFeedbackModal);
  ui.feedbackModal.addEventListener("click", (event) => {
    if (event.target === ui.feedbackModal) {
      closeFeedbackModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.feedbackModal.classList.contains("open")) {
      closeFeedbackModal();
    }
  });
}

function openFeedbackModal(title, message, type) {
  if (!ui.feedbackModal) {
    return;
  }

  ui.feedbackModalTitle.textContent = title;
  ui.feedbackModalMessage.textContent = message;
  ui.feedbackModalBadge.textContent = type === "success" ? "Confirmed" : "Error";
  ui.feedbackModalBadge.classList.remove("is-success", "is-error");
  ui.feedbackModalBadge.classList.add(type === "success" ? "is-success" : "is-error");
  ui.feedbackModal.classList.add("open");
  ui.feedbackModal.setAttribute("aria-hidden", "false");
}

function closeFeedbackModal() {
  if (!ui.feedbackModal) {
    return;
  }

  ui.feedbackModal.classList.remove("open");
  ui.feedbackModal.setAttribute("aria-hidden", "true");
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
      .filter((item) => item && item.type === "file" && item.name.endsWith(".csv"))
      .map((item) => {
        return {
          name: item.name,
          sortKey: getGovernanceHistorySortKey(item.name),
          dateLabel: formatGovernanceHistoryDate(item.name),
          downloadUrl: `${GOVERNANCE_HISTORY_RAW_BASE}${item.name}`,
        };
      })
      .sort((first, second) => second.sortKey.localeCompare(first.sortKey));

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

function getWalletProposalState(proposalId) {
  if (!state.walletData || !Array.isArray(state.walletData.proposal_states)) {
    return null;
  }

  return state.walletData.proposal_states.find((item) => item.proposal_id === proposalId) || null;
}

function getProposalFileNameById(proposalId) {
  const proposal = state.proposals.find((item) => item.proposal_id === proposalId);
  return proposal && proposal.csv_file_name
    ? proposal.csv_file_name
    : `proposal_${proposalId}.csv`;
}

async function hashProposalPayload(proposal) {
  const payload = {
    title: String(proposal && proposal.title ? proposal.title : "").trim(),
    description: String(proposal && proposal.description ? proposal.description : "").trim(),
    options: Array.isArray(proposal && proposal.options)
      ? proposal.options.map((option) => String(option || "").trim()).filter(Boolean)
      : [],
  };
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

function getGovernanceHistorySortKey(fileName) {
  const isoMatch = String(fileName).match(/_(\d{4}-\d{2}-\d{2})\.csv$/);
  if (isoMatch) {
    return isoMatch[1];
  }

  const legacyMatch = String(fileName).match(/(?:^|_)(\d{10,})\.csv$/);
  if (legacyMatch) {
    return legacyMatch[1];
  }

  return fileName;
}

function formatGovernanceHistoryDate(fileName) {
  const isoMatch = String(fileName).match(/_(\d{4}-\d{2}-\d{2})\.csv$/);
  if (isoMatch) {
    return isoMatch[1];
  }

  const legacyMatch = String(fileName).match(/(?:^|_)(\d{10,})\.csv$/);
  if (legacyMatch) {
    return formatHistoryDate(Number(legacyMatch[1]));
  }

  return "--";
}

function formatVotingPower(value) {
  return Number(value || 0).toFixed(6);
}

function formatParticipationRate(value, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return "0.0%";
  }

  return `${((Number(value || 0) / total) * 100).toFixed(1)}%`;
}

function getProposalStatusLabel(status) {
  if (status === "active") {
    return "Voting Active";
  }

  if (status === "scheduled") {
    return "Voting Scheduled";
  }

  if (status === "ended") {
    return "Voting Ended";
  }

  return "Voting Inactive";
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
