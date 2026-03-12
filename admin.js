const ADMIN_WALLET = "5feimx18jM2hK2rvZnQHRsjhSeCkHAiLeQZDuJkU2fPc";
const state = {
  adminWallet: null,
};

const ui = {
  connectButton: document.getElementById("connectAdminButton"),
  status: document.getElementById("adminStatus"),
  feedback: document.getElementById("adminFeedback"),
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
};

ui.connectButton.addEventListener("click", connectAdminWallet);
ui.startVotingButton.addEventListener("click", startVoting);
ui.resetVotingButton.addEventListener("click", resetVoting);

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

    if (walletAddress !== ADMIN_WALLET) {
      ui.dashboard.hidden = true;
      ui.walletAddress.textContent = walletAddress;
      ui.status.textContent = "Unauthorized admin wallet.";
      setFeedback("Unauthorized admin wallet.", "error");
      return;
    }

    state.adminWallet = walletAddress;
    ui.walletAddress.textContent = walletAddress;
    ui.dashboard.hidden = false;
    ui.status.textContent = "Admin wallet autorizzato. Puoi gestire la governance.";
    setFeedback("", "");
  } catch (error) {
    console.error(error);
    ui.status.textContent = "Errore durante la connessione del wallet admin.";
    setFeedback("An error occurred while connecting the admin wallet.", "error");
  } finally {
    ui.connectButton.disabled = false;
  }
}

async function startVoting() {
  if (!state.adminWallet) {
    setFeedback("Unauthorized admin wallet.", "error");
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
    setFeedback("Fill in title, description and at least one option.", "error");
    return;
  }

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    setFeedback("Set a valid start and end date. End must be after start.", "error");
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
    setAdminBusy(true);
    const response = await fetch("/api/admin/proposal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.success !== true) {
      throw new Error(result && result.error ? result.error : "SERVER_ERROR");
    }

    ui.status.textContent = "Proposal salvata e votazione avviata.";
    setFeedback("Voting configuration saved successfully.", "success");
  } catch (error) {
    console.error(error);
    if (error.message === "UNAUTHORIZED_ADMIN") {
      setFeedback("Unauthorized admin wallet.", "error");
      return;
    }

    if (error.message === "INVALID_PROPOSAL") {
      setFeedback("Fill in title, description and at least one option.", "error");
      return;
    }

    if (error.message === "INVALID_TIME_RANGE") {
      setFeedback("Set a valid start and end date. End must be after start.", "error");
      return;
    }

    setFeedback("An error occurred while saving the proposal.", "error");
  } finally {
    setAdminBusy(false);
  }
}

async function resetVoting() {
  if (!state.adminWallet) {
    setFeedback("Unauthorized admin wallet.", "error");
    return;
  }

  try {
    setAdminBusy(true);
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
    ui.status.textContent = "Votazione resettata completamente.";
    setFeedback("Voting reset completed.", "success");
  } catch (error) {
    console.error(error);
    setFeedback(error.message === "UNAUTHORIZED_ADMIN"
      ? "Unauthorized admin wallet."
      : "An error occurred while resetting the vote.", "error");
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

function setFeedback(message, type) {
  ui.feedback.textContent = message;
  ui.feedback.classList.remove("is-success", "is-error");

  if (type) {
    ui.feedback.classList.add(type === "success" ? "is-success" : "is-error");
  }
}

function setAdminBusy(isBusy) {
  ui.startVotingButton.disabled = isBusy;
  ui.resetVotingButton.disabled = isBusy;
  ui.startVotingButton.textContent = isBusy ? "Saving..." : "Start Voting";
  ui.resetVotingButton.textContent = isBusy ? "Working..." : "Reset Voting";
}

function toUnixTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : NaN;
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
