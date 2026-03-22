const AUTHORIZED_ADMIN_WALLETS = new Set([
  "5feimx18jM2hK2rvZnQHRsjhSeCkHAiLeQZDuJkU2fPc",
  "4hcKvjU4EMzz5TSjgk7CMwhTwy4gXTuhdEYHyd5Shaz8",
]);
const APP_BASE_PATH = "/torrino.dao.voting";
const API_BASE_PATH = `${APP_BASE_PATH}/api`;
const GOVERNANCE_HISTORY_API = "https://api.github.com/repos/Happydao/torrino-dao-voting-core/contents/data";
const GOVERNANCE_HISTORY_RAW_BASE = "https://raw.githubusercontent.com/Happydao/torrino-dao-voting-core/main/data/";
const textEncoder = new TextEncoder();
const state = {
  adminWallet: null,
  adminProvider: null,
  currentProposal: null,
  proposalRefreshIntervalId: null,
  proposalCountdownIntervalId: null,
  governanceHistory: [],
  governanceHistoryLoaded: false,
};

const ui = {
  connectButton: document.getElementById("connectAdminButton"),
  status: document.getElementById("adminStatus"),
  actionStatus: document.getElementById("admin-status"),
  feedbackModal: document.getElementById("adminFeedbackModal"),
  feedbackModalHeadline: document.getElementById("adminFeedbackModalHeadline"),
  feedbackModalBadge: document.getElementById("adminFeedbackModalBadge"),
  feedbackModalTitle: document.getElementById("adminFeedbackModalTitle"),
  feedbackModalMessage: document.getElementById("adminFeedbackModalMessage"),
  closeFeedbackModal: document.getElementById("closeAdminFeedbackModal"),
  dashboard: document.getElementById("adminDashboard"),
  walletAddress: document.getElementById("adminWalletAddress"),
  startVotingButton: document.getElementById("startVotingButton"),
  resetVotingButton: document.getElementById("resetVotingButton"),
  proposalNotice: document.getElementById("adminProposalNotice"),
  proposalNoticeBadge: document.getElementById("adminProposalNoticeBadge"),
  proposalNoticeTitle: document.getElementById("adminProposalNoticeTitle"),
  proposalNoticeId: document.getElementById("adminProposalNoticeId"),
  proposalNoticeCountdown: document.getElementById("adminProposalNoticeCountdown"),
  proposalNoticeLink: document.getElementById("adminProposalNoticeLink"),
  historyModal: document.getElementById("adminHistoryModal"),
  openHistoryModal: document.getElementById("openAdminHistoryModal"),
  closeHistoryModal: document.getElementById("closeAdminHistoryModal"),
  historyTableBody: document.getElementById("adminHistoryTableBody"),
  title: document.getElementById("proposalTitleInput"),
  description: document.getElementById("proposalDescriptionInput"),
  optionA: document.getElementById("optionAInput"),
  optionB: document.getElementById("optionBInput"),
  optionC: document.getElementById("optionCInput"),
  optionD: document.getElementById("optionDInput"),
  optionE: document.getElementById("optionEInput"),
  startTime: document.getElementById("startTimeInput"),
  endTime: document.getElementById("endTimeInput"),
  openStartTimePickerButton: document.getElementById("openStartTimePickerButton"),
  openEndTimePickerButton: document.getElementById("openEndTimePickerButton"),
};

ui.connectButton.addEventListener("click", handleAdminWalletButtonClick);
ui.startVotingButton.addEventListener("click", startVoting);
ui.resetVotingButton.addEventListener("click", resetVoting);
ui.openStartTimePickerButton.addEventListener("click", () => openDateTimePicker(ui.startTime));
ui.openEndTimePickerButton.addEventListener("click", () => openDateTimePicker(ui.endTime));
updateAdminConnectButtonLabel();
initializeAdminFeedbackModal();
initializeAdminProposalNotice();
initializeHistoryModal();

async function handleAdminWalletButtonClick() {
  if (state.adminWallet && state.adminProvider) {
    await disconnectAdminWallet();
    return;
  }

  await connectAdminWallet();
}

async function connectAdminWallet() {
  const provider = getWalletProvider();

  if (!provider) {
    ui.status.textContent = "Phantom or Solflare were not detected.";
    return;
  }

  try {
    ui.connectButton.disabled = true;
    ui.status.textContent = "Connecting admin wallet...";
    const walletAddress = await connectWalletProvider(provider);

    if (!AUTHORIZED_ADMIN_WALLETS.has(walletAddress)) {
      state.adminWallet = walletAddress;
      state.adminProvider = provider;
      ui.dashboard.hidden = true;
      ui.walletAddress.textContent = walletAddress;
      ui.status.textContent = "Unauthorized admin wallet.";
      setActionStatus("Unauthorized admin wallet.", "error");
      return;
    }

    state.adminWallet = walletAddress;
    state.adminProvider = provider;
    ui.walletAddress.textContent = walletAddress;
    ui.dashboard.hidden = false;
    ui.status.textContent = "Authorized admin wallet connected. You can manage governance.";
    setActionStatus("", "");
    await refreshAdminProposalNotice();
  } catch (error) {
    console.error(error);
    ui.status.textContent = "An error occurred while connecting the admin wallet.";
    setActionStatus("An error occurred while connecting the admin wallet.", "error");
  } finally {
    setAdminConnectBusy(false);
  }
}

async function disconnectAdminWallet() {
  const provider = state.adminProvider;

  try {
    setAdminConnectBusy(true, "Disconnecting...");
    await disconnectWalletProvider(provider);
  } catch (error) {
    console.error(error);
  } finally {
    clearAdminSession();
    setAdminConnectBusy(false);
  }
}

async function startVoting() {
  if (!state.adminWallet) {
    setActionStatus("Unauthorized admin wallet.", "error");
    return;
  }

  await refreshAdminProposalNotice();

  if (
    state.currentProposal &&
    (state.currentProposal.status === "active" || state.currentProposal.status === "scheduled")
  ) {
    const message = "A proposal is already active or scheduled. Stop the current proposal before starting a new one.";
    setActionStatus(message, "error");
    openAdminFeedbackModal("Active Proposal", message, "error");
    return;
  }

  const title = ui.title.value.trim();
  const description = ui.description.value.trim();
  const options = [
    ui.optionA.value.trim(),
    ui.optionB.value.trim(),
    ui.optionC.value.trim(),
    ui.optionD.value.trim(),
    ui.optionE.value.trim(),
  ].filter(Boolean);
  const startTime = toUnixTimestamp(ui.startTime.value);
  const endTime = toUnixTimestamp(ui.endTime.value);

  if (!title || !description || options.length === 0) {
    setActionStatus("Fill in title, description and at least one option.", "error");
    return;
  }

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    setActionStatus("Set a valid start and end date. End must be after start.", "error");
    return;
  }

  const payload = {
    admin_wallet: state.adminWallet,
    title,
    description,
    options,
    start_time: startTime,
    end_time: endTime,
  };

  try {
    setAdminBusy(true, "Signing...", "Signing...");
    setActionStatus("Awaiting wallet signature...", "");
    payload.admin_signed_message = await buildStartProposalAdminMessage(payload);
    payload.admin_signature = await confirmAdminAction(payload.admin_signed_message);
    setAdminBusy(true, "Saving...", "Stop Voting");
    setActionStatus("Signature confirmed. Starting voting...", "");
    const response = await fetch(`${API_BASE_PATH}/admin/proposal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.success !== true) {
      throw new Error(result && result.error ? result.error : "SERVER_ERROR");
    }

    await refreshAdminProposalNotice();
    setActionStatus("Voting started successfully.", "success");
    openAdminFeedbackModal("Voting Started", "Voting started successfully.", "success");
  } catch (error) {
    console.error(error);
    if (error.message === "UNAUTHORIZED_ADMIN") {
      setActionStatus("Unauthorized admin wallet.", "error");
      openAdminFeedbackModal("Admin Error", "Unauthorized admin wallet.", "error");
      return;
    }

    if (error.message === "INVALID_ADMIN_SIGNATURE") {
      setActionStatus("Action failed: admin signature is not valid.", "error");
      openAdminFeedbackModal("Admin Error", "Action failed: admin signature is not valid.", "error");
      return;
    }

    if (error.message === "INVALID_PROPOSAL") {
      setActionStatus("Fill in title, description and at least one option.", "error");
      return;
    }

    if (error.message === "PROPOSAL_ALREADY_ACTIVE") {
      const message = "A proposal is already active or scheduled. Stop the current proposal before starting a new one.";
      setActionStatus(message, "error");
      openAdminFeedbackModal("Active Proposal", message, "error");
      return;
    }

    if (error.message === "INVALID_TIME_RANGE") {
      setActionStatus("Set a valid start and end date. End must be after start.", "error");
      return;
    }

    if (error.message === "SIGNATURE_REJECTED") {
      setActionStatus("Action cancelled: wallet signature was rejected.", "error");
      openAdminFeedbackModal("Admin Error", "Action cancelled: wallet signature was rejected.", "error");
      return;
    }

    setActionStatus("Action failed while starting voting.", "error");
    openAdminFeedbackModal("Admin Error", "Action failed while starting voting.", "error");
  } finally {
    setAdminBusy(false);
  }
}

async function resetVoting() {
  if (!state.adminWallet) {
    setActionStatus("Unauthorized admin wallet.", "error");
    return;
  }

  try {
    const proposal = await getCurrentProposal();

    if (!proposal || !proposal.proposal_id) {
      throw new Error("NO_ACTIVE_PROPOSAL");
    }

    setAdminBusy(true, "Start Voting", "Signing...");
    setActionStatus("Awaiting wallet signature...", "");
    const adminSignedMessage = await buildResetProposalAdminMessage(proposal.proposal_id);
    const adminSignature = await confirmAdminAction(adminSignedMessage);
    setAdminBusy(true, "Start Voting", "Working...");
    setActionStatus("Signature confirmed. Resetting voting...", "");
    const response = await fetch(`${API_BASE_PATH}/admin/reset-voting`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        admin_wallet: state.adminWallet,
        admin_signed_message: adminSignedMessage,
        admin_signature: adminSignature,
      }),
    });
    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.success !== true) {
      throw new Error(result && result.error ? result.error : "SERVER_ERROR");
    }

    await refreshAdminProposalNotice();
    clearForm();
    ui.dashboard.hidden = false;
    setActionStatus("Voting reset successfully.", "success");
    openAdminFeedbackModal("Voting Stopped", "Voting reset successfully.", "success");
  } catch (error) {
    console.error(error);
    if (error.message === "SIGNATURE_REJECTED") {
      setActionStatus("Action cancelled: wallet signature was rejected.", "error");
      openAdminFeedbackModal("Admin Error", "Action cancelled: wallet signature was rejected.", "error");
      return;
    }

    const errorMessage = error.message === "UNAUTHORIZED_ADMIN"
      ? "Unauthorized admin wallet."
      : error.message === "NO_ACTIVE_PROPOSAL"
        ? "No active proposal found."
      : error.message === "INVALID_ADMIN_SIGNATURE"
        ? "Action failed: admin signature is not valid."
        : "Action failed while resetting voting.";
    setActionStatus(errorMessage, "error");
    openAdminFeedbackModal("Admin Error", errorMessage, "error");
  } finally {
    setAdminBusy(false);
  }
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

async function disconnectWalletProvider(provider) {
  if (provider && typeof provider.disconnect === "function") {
    await provider.disconnect();
  }
}

function setActionStatus(message, type) {
  ui.actionStatus.textContent = message;
  ui.actionStatus.classList.remove("is-success", "is-error");

  if (type) {
    ui.actionStatus.classList.add(type === "success" ? "is-success" : "is-error");
  }
}

function setAdminConnectBusy(isBusy, busyLabel = "Connecting...") {
  ui.connectButton.disabled = isBusy;
  ui.connectButton.textContent = isBusy ? busyLabel : getAdminConnectButtonLabel();
}

function updateAdminConnectButtonLabel() {
  ui.connectButton.textContent = getAdminConnectButtonLabel();
}

function getAdminConnectButtonLabel() {
  return state.adminWallet ? "Disconnect Wallet" : "Connect Admin Wallet";
}

function setAdminBusy(isBusy, startLabel = "Start Voting", resetLabel = "Stop Voting") {
  ui.startVotingButton.disabled = isBusy;
  ui.resetVotingButton.disabled = isBusy;
  ui.startVotingButton.textContent = isBusy ? startLabel : "Start Voting";
  ui.resetVotingButton.textContent = isBusy ? resetLabel : "Stop Voting";
}

function toUnixTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : NaN;
}

async function confirmAdminAction(message) {
  const provider = state.adminProvider || getWalletProvider();

  if (!provider || typeof provider.signMessage !== "function") {
    throw new Error("SIGNATURE_UNAVAILABLE");
  }

  try {
    const encodedMessage = textEncoder.encode(message);
    const signed = await provider.signMessage(encodedMessage, "utf8");
    const signatureBytes = extractSignatureBytes(signed);

    if (!signatureBytes) {
      throw new Error("SIGNATURE_UNAVAILABLE");
    }

    return bytesToBase58(signatureBytes);
  } catch (error) {
    if (isSignatureRejected(error)) {
      throw new Error("SIGNATURE_REJECTED");
    }

    throw error;
  }
}

async function getCurrentProposal() {
  const response = await fetch(`${API_BASE_PATH}/proposal`);
  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload || payload.proposal === null) {
    return null;
  }

  return payload;
}

async function buildStartProposalAdminMessage(payload) {
  const payloadHash = await hashAdminActionPayload({
    title: payload.title,
    description: payload.description,
    options: payload.options,
    start_time: payload.start_time,
    end_time: payload.end_time,
  });

  return `Torrino DAO admin action:start:wallet:${payload.admin_wallet}:payload_hash:${payloadHash}:timestamp:${Date.now()}`;
}

async function buildResetProposalAdminMessage(proposalId) {
  return `Torrino DAO admin action:stop:wallet:${state.adminWallet}:proposal:${proposalId}:timestamp:${Date.now()}`;
}

async function hashAdminActionPayload(value) {
  const normalized = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(normalized));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isSignatureRejected(error) {
  const errorMessage = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return error?.code === 4001 || errorMessage.includes("reject") || errorMessage.includes("denied");
}

function clearForm() {
  ui.title.value = "";
  ui.description.value = "";
  ui.optionA.value = "";
  ui.optionB.value = "";
  ui.optionC.value = "";
  ui.optionD.value = "";
  ui.optionE.value = "";
  ui.startTime.value = "";
  ui.endTime.value = "";
}

function clearAdminSession() {
  state.adminWallet = null;
  state.adminProvider = null;
  state.currentProposal = null;
  ui.walletAddress.textContent = "Not connected";
  ui.dashboard.hidden = true;
  ui.status.textContent = "Admin wallet disconnected.";
  setActionStatus("", "");
  renderAdminProposalNotice();
}

function initializeAdminProposalNotice() {
  refreshAdminProposalNotice();

  state.proposalRefreshIntervalId = window.setInterval(() => {
    refreshAdminProposalNotice();
  }, 30000);

  state.proposalCountdownIntervalId = window.setInterval(() => {
    renderAdminProposalNotice();
  }, 1000);
}

async function refreshAdminProposalNotice() {
  try {
    state.currentProposal = await getCurrentProposal();
  } catch (error) {
    console.error(error);
    state.currentProposal = null;
  }

  renderAdminProposalNotice();
}

function renderAdminProposalNotice() {
  const proposal = state.currentProposal;

  if (!proposal || !ui.proposalNotice) {
    ui.proposalNotice.hidden = true;
    return;
  }

  if (proposal.status !== "active" && proposal.status !== "scheduled") {
    ui.proposalNotice.hidden = true;
    return;
  }

  const isScheduled = proposal.status === "scheduled";
  ui.proposalNotice.hidden = false;
  ui.proposalNoticeBadge.textContent = isScheduled ? "Proposal scheduled" : "Voting in progress";
  ui.proposalNoticeTitle.textContent = proposal.title || "Active proposal";
  ui.proposalNoticeId.textContent = `Proposal ID: ${proposal.proposal_id || "--"}`;
  ui.proposalNoticeCountdown.textContent = isScheduled
    ? `Starts in: ${formatAdminCountdown(proposal.start_time)}`
    : `Ends in: ${formatAdminCountdown(proposal.end_time)}`;
  ui.proposalNoticeLink.href = `${APP_BASE_PATH}/`;
}

function formatAdminCountdown(unixTimestampSeconds) {
  const targetMs = Number(unixTimestampSeconds) * 1000;

  if (!Number.isFinite(targetMs)) {
    return "--";
  }

  const remainingMs = Math.max(0, targetMs - Date.now());
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function initializeAdminFeedbackModal() {
  if (!ui.feedbackModal || !ui.closeFeedbackModal) {
    return;
  }

  ui.closeFeedbackModal.addEventListener("click", closeAdminFeedbackModal);
  ui.feedbackModal.addEventListener("click", (event) => {
    if (event.target === ui.feedbackModal) {
      closeAdminFeedbackModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.feedbackModal.classList.contains("open")) {
      closeAdminFeedbackModal();
    }
  });
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
    row.append(nameCell, dateCell, actionCell);
    ui.historyTableBody.appendChild(row);
  }
}

async function downloadGovernanceCsv(url, fileName) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("DOWNLOAD_FAILED");
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function closeHistoryModal() {
  if (!ui.historyModal) {
    return;
  }

  ui.historyModal.classList.remove("open");
  ui.historyModal.setAttribute("aria-hidden", "true");
  ui.openHistoryModal.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}

function formatHistoryDate(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "Unknown date";
  }

  return new Date(timestamp * 1000).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }) + " UTC";
}

function openAdminFeedbackModal(title, message, type) {
  if (!ui.feedbackModal) {
    return;
  }

  ui.feedbackModalHeadline.textContent = title === "Voting Started" || title === "Voting Stopped"
    ? "SHOCK ALLA ZANZARA!!"
    : "";
  ui.feedbackModalTitle.textContent = title;
  ui.feedbackModalMessage.textContent = message;
  ui.feedbackModalBadge.textContent = type === "success" ? "Confirmed" : "Error";
  ui.feedbackModalBadge.classList.remove("is-success", "is-error");
  ui.feedbackModalBadge.classList.add(type === "success" ? "is-success" : "is-error");
  ui.feedbackModal.classList.add("open");
  ui.feedbackModal.setAttribute("aria-hidden", "false");
}

function closeAdminFeedbackModal() {
  if (!ui.feedbackModal) {
    return;
  }

  ui.feedbackModal.classList.remove("open");
  ui.feedbackModal.setAttribute("aria-hidden", "true");
}

function openDateTimePicker(input) {
  if (!input) {
    return;
  }

  input.focus();

  if (typeof input.showPicker === "function") {
    input.showPicker();
    return;
  }

  input.click();
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
