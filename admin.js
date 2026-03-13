const AUTHORIZED_ADMIN_WALLETS = new Set([
  "5feimx18jM2hK2rvZnQHRsjhSeCkHAiLeQZDuJkU2fPc",
  "4hcKvjU4EMzz5TSjgk7CMwhTwy4gXTuhdEYHyd5Shaz8",
]);
const ADMIN_CONFIRMATION_MESSAGE = "Confirm admin action for Torrino DAO voting";
const state = {
  adminWallet: null,
};

const ui = {
  connectButton: document.getElementById("connectAdminButton"),
  status: document.getElementById("adminStatus"),
  actionStatus: document.getElementById("admin-status"),
  dashboard: document.getElementById("adminDashboard"),
  walletAddress: document.getElementById("adminWalletAddress"),
  startVotingButton: document.getElementById("startVotingButton"),
  resetVotingButton: document.getElementById("resetVotingButton"),
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

ui.connectButton.addEventListener("click", connectAdminWallet);
ui.startVotingButton.addEventListener("click", startVoting);
ui.resetVotingButton.addEventListener("click", resetVoting);
ui.openStartTimePickerButton.addEventListener("click", () => openDateTimePicker(ui.startTime));
ui.openEndTimePickerButton.addEventListener("click", () => openDateTimePicker(ui.endTime));

async function connectAdminWallet() {
  const provider = getPhantomProvider();

  if (!provider) {
    ui.status.textContent = "Phantom wallet non rilevato.";
    return;
  }

  try {
    ui.connectButton.disabled = true;
    ui.status.textContent = "Connessione wallet admin in corso...";
    const response = await provider.connect();
    const walletAddress = response.publicKey.toString();

    if (!AUTHORIZED_ADMIN_WALLETS.has(walletAddress)) {
      ui.dashboard.hidden = true;
      ui.walletAddress.textContent = walletAddress;
      ui.status.textContent = "Unauthorized admin wallet.";
      setActionStatus("Unauthorized admin wallet.", "error");
      return;
    }

    state.adminWallet = walletAddress;
    ui.walletAddress.textContent = walletAddress;
    ui.dashboard.hidden = false;
    ui.status.textContent = "Admin wallet autorizzato. Puoi gestire la governance.";
    setActionStatus("", "");
  } catch (error) {
    console.error(error);
    ui.status.textContent = "Errore durante la connessione del wallet admin.";
    setActionStatus("An error occurred while connecting the admin wallet.", "error");
  } finally {
    ui.connectButton.disabled = false;
  }
}

async function startVoting() {
  if (!state.adminWallet) {
    setActionStatus("Unauthorized admin wallet.", "error");
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
    setActionStatus("Awaiting Phantom signature...", "");
    await confirmAdminAction();
    setAdminBusy(true, "Saving...", "Reset Voting");
    setActionStatus("Signature confirmed. Starting voting...", "");
    const response = await fetch("/api/admin/proposal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.success !== true) {
      throw new Error(result && result.error ? result.error : "SERVER_ERROR");
    }

    setActionStatus("Voting started successfully.", "success");
  } catch (error) {
    console.error(error);
    if (error.message === "UNAUTHORIZED_ADMIN") {
      setActionStatus("Unauthorized admin wallet.", "error");
      return;
    }

    if (error.message === "INVALID_PROPOSAL") {
      setActionStatus("Fill in title, description and at least one option.", "error");
      return;
    }

    if (error.message === "INVALID_TIME_RANGE") {
      setActionStatus("Set a valid start and end date. End must be after start.", "error");
      return;
    }

    if (error.message === "SIGNATURE_REJECTED") {
      setActionStatus("Action cancelled: Phantom signature was rejected.", "error");
      return;
    }

    setActionStatus("Action failed while starting voting.", "error");
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
    setAdminBusy(true, "Start Voting", "Signing...");
    setActionStatus("Awaiting Phantom signature...", "");
    await confirmAdminAction();
    setAdminBusy(true, "Start Voting", "Working...");
    setActionStatus("Signature confirmed. Resetting voting...", "");
    const response = await fetch("/api/admin/reset-voting", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admin_wallet: state.adminWallet }),
    });
    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.success !== true) {
      throw new Error(result && result.error ? result.error : "SERVER_ERROR");
    }

    clearForm();
    ui.dashboard.hidden = false;
    setActionStatus("Voting reset successfully.", "success");
  } catch (error) {
    console.error(error);
    if (error.message === "SIGNATURE_REJECTED") {
      setActionStatus("Action cancelled: Phantom signature was rejected.", "error");
      return;
    }

    setActionStatus(
      error.message === "UNAUTHORIZED_ADMIN"
        ? "Unauthorized admin wallet."
        : "Action failed while resetting voting.",
      "error"
    );
  } finally {
    setAdminBusy(false);
  }
}

function getPhantomProvider() {
  if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) {
    return window.phantom.solana;
  }

  return window.solana && window.solana.isPhantom ? window.solana : null;
}

function setActionStatus(message, type) {
  ui.actionStatus.textContent = message;
  ui.actionStatus.classList.remove("is-success", "is-error");

  if (type) {
    ui.actionStatus.classList.add(type === "success" ? "is-success" : "is-error");
  }
}

function setAdminBusy(isBusy, startLabel = "Start Voting", resetLabel = "Reset Voting") {
  ui.startVotingButton.disabled = isBusy;
  ui.resetVotingButton.disabled = isBusy;
  ui.startVotingButton.textContent = isBusy ? startLabel : "Start Voting";
  ui.resetVotingButton.textContent = isBusy ? resetLabel : "Reset Voting";
}

function toUnixTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : NaN;
}

async function confirmAdminAction() {
  const provider = getPhantomProvider();

  if (!provider || typeof provider.signMessage !== "function") {
    throw new Error("SIGNATURE_UNAVAILABLE");
  }

  try {
    const encodedMessage = new TextEncoder().encode(ADMIN_CONFIRMATION_MESSAGE);
    await provider.signMessage(encodedMessage, "utf8");
  } catch (error) {
    if (isSignatureRejected(error)) {
      throw new Error("SIGNATURE_REJECTED");
    }

    throw error;
  }
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
