const APP_BASE_PATH = "/torrino.dao.voting";
const VERIFY_VOTE_ENDPOINT = `${APP_BASE_PATH}/api/verify-vote-record`;
const VERIFY_PROPOSAL_HASH_ENDPOINT = `${APP_BASE_PATH}/api/verify-proposal-hash`;

const ui = {
  proposalHashForm: document.getElementById("proposalHashVerifierForm"),
  proposalHashInput: document.getElementById("verifyProposalHashInput"),
  proposalHashButton: document.getElementById("verifyProposalHashButton"),
  proposalHashStatus: document.getElementById("proposalHashStatus"),
  proposalHashResultCard: document.getElementById("proposalHashResultCard"),
  proposalHashResultBadge: document.getElementById("proposalHashResultBadge"),
  proposalHashResultHeadline: document.getElementById("proposalHashResultHeadline"),
  proposalHashResultMessage: document.getElementById("proposalHashResultMessage"),
  proposalHashResultDetails: document.getElementById("proposalHashResultDetails"),
  proposalHashResultPayload: document.getElementById("proposalHashResultPayload"),
  voteForm: document.getElementById("voteVerifierForm"),
  proposalHashForVote: document.getElementById("verifyVoteProposalHashInput"),
  wallet: document.getElementById("verifyWalletInput"),
  signedMessage: document.getElementById("verifySignedMessageInput"),
  signature: document.getElementById("verifySignatureInput"),
  verifyVoteButton: document.getElementById("verifyVoteButton"),
  voteStatus: document.getElementById("verifyStatus"),
  voteResultCard: document.getElementById("verifyResultCard"),
  voteResultBadge: document.getElementById("verifyResultBadge"),
  voteResultHeadline: document.getElementById("verifyResultHeadline"),
  voteResultMessage: document.getElementById("verifyResultMessage"),
  voteResultDetails: document.getElementById("verifyResultDetails"),
};

ui.proposalHashForm.addEventListener("submit", handleProposalHashVerification);
ui.voteForm.addEventListener("submit", handleVoteVerification);

async function handleProposalHashVerification(event) {
  event.preventDefault();

  const proposalPayloadHash = ui.proposalHashInput.value.trim().toLowerCase();

  if (!proposalPayloadHash) {
    setProposalHashStatus("Paste proposal_payload_hash from the CSV metadata.", "error");
    hideProposalHashResult();
    return;
  }

  try {
    setProposalHashBusy(true);
    setProposalHashStatus("Verifying proposal hash...", "");
    hideProposalHashResult();

    const response = await fetch(VERIFY_PROPOSAL_HASH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposal_payload_hash: proposalPayloadHash,
      }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      throw new Error(payload && payload.error ? payload.error : "SERVER_ERROR");
    }

    renderProposalHashResult(payload);
    setProposalHashStatus(
      payload.valid
        ? "Proposal hash verified successfully."
        : "Proposal hash not found or does not match the published CSV metadata.",
      payload.valid ? "success" : "error"
    );

    if (payload.valid) {
      ui.proposalHashForVote.value = proposalPayloadHash;
    }
  } catch (error) {
    console.error(error);
    hideProposalHashResult();
    setProposalHashStatus("An error occurred while verifying the proposal hash.", "error");
  } finally {
    setProposalHashBusy(false);
  }
}

async function handleVoteVerification(event) {
  event.preventDefault();

  const proposalPayloadHash = ui.proposalHashForVote.value.trim().toLowerCase();
  const wallet = ui.wallet.value.trim();
  const signedMessage = ui.signedMessage.value.trim();
  const signature = ui.signature.value.trim();

  if (!proposalPayloadHash || !wallet || !signedMessage || !signature) {
    setVoteStatus("Fill in proposal hash, wallet, signed message and signature.", "error");
    hideVoteResult();
    return;
  }

  try {
    setVoteBusy(true);
    setVoteStatus("Verifying vote signature and proposal hash...", "");
    hideVoteResult();

    const response = await fetch(VERIFY_VOTE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposal_payload_hash: proposalPayloadHash,
        wallet,
        signed_message: signedMessage,
        signature,
      }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      throw new Error("SERVER_ERROR");
    }

    renderVoteVerificationResult(payload);
    setVoteStatus(
      payload.valid
        ? "Vote verification completed successfully."
        : "Vote verification failed. The row does not match a valid vote signature tied to the same proposal hash.",
      payload.valid ? "success" : "error"
    );
  } catch (error) {
    console.error(error);
    hideVoteResult();
    setVoteStatus("An error occurred while verifying the vote.", "error");
  } finally {
    setVoteBusy(false);
  }
}

function renderProposalHashResult(result) {
  ui.proposalHashResultCard.hidden = false;
  ui.proposalHashResultBadge.textContent = "Proposal hash result";
  ui.proposalHashResultBadge.classList.remove("is-success", "is-error");
  ui.proposalHashResultHeadline.textContent = result.valid ? "TRUE" : "FALSE";
  ui.proposalHashResultMessage.textContent = result.valid
    ? "The proposal hash matches the published proposal content stored in the CSV."
    : getProposalHashFailureMessage(result.reason);
  ui.proposalHashResultDetails.textContent = result.valid
    ? `CSV file: ${result.csv_file_name || "--"}`
    : `Reason: ${result.reason || "UNKNOWN_ERROR"}`;
  ui.proposalHashResultPayload.textContent = result.valid
    ? JSON.stringify(result.proposal_payload, null, 2)
    : "";
  ui.proposalHashResultBadge.classList.add(result.valid ? "is-success" : "is-error");
}

function renderVoteVerificationResult(result) {
  const csvFileName = result.csv_file_name || result.proposal_id || "--";
  ui.voteResultCard.hidden = false;
  ui.voteResultBadge.textContent = "Vote verification result";
  ui.voteResultBadge.classList.remove("is-success", "is-error");
  ui.voteResultHeadline.textContent = result.valid ? "TRUE" : "FALSE";
  ui.voteResultMessage.textContent = result.valid
    ? "The signature is valid, and the vote row points to the same proposal hash published in the CSV."
    : getVoteVerificationFailureMessage(result.reason);
  ui.voteResultDetails.textContent = result.valid
    ? `CSV file: ${csvFileName} | Wallet: ${result.wallet} | Proposal hash: ${result.proposal_hash || "--"} | Vote option: ${result.vote_option}`
    : `Reason: ${result.reason || "UNKNOWN_ERROR"}`;
  ui.voteResultBadge.classList.add(result.valid ? "is-success" : "is-error");
}

function hideProposalHashResult() {
  ui.proposalHashResultCard.hidden = true;
}

function hideVoteResult() {
  ui.voteResultCard.hidden = true;
}

function getProposalHashFailureMessage(reason) {
  if (reason === "PROPOSAL_HASH_NOT_FOUND") {
    return "The proposal hash was not found in the published CSV files, or the proposal content does not match that hash.";
  }

  return "The proposal hash could not be verified.";
}

function getVoteVerificationFailureMessage(reason) {
  if (reason === "INVALID_SIGNATURE") {
    return "The signature does not match the wallet and signed message provided.";
  }

  if (reason === "INVALID_MESSAGE_FORMAT") {
    return "The signed message format is not a valid Torrino DAO vote message.";
  }

  if (reason === "MESSAGE_MISMATCH") {
    return "The wallet written inside the signed message does not match the wallet field you entered.";
  }

  if (reason === "PROPOSAL_HASH_MISSING") {
    return "This signed message does not contain a proposal hash, so it cannot be matched to the CSV proposal hash.";
  }

  if (reason === "PROPOSAL_HASH_NOT_FOUND") {
    return "The proposal hash you entered was not found in the published CSV files.";
  }

  if (reason === "PROPOSAL_HASH_MISMATCH") {
    return "The proposal hash inside the signed message does not match the proposal hash copied from the CSV metadata.";
  }

  return "The vote could not be verified.";
}

function setProposalHashStatus(message, type) {
  ui.proposalHashStatus.textContent = message;
  ui.proposalHashStatus.classList.remove("is-success", "is-error");

  if (type === "success" || type === "error") {
    ui.proposalHashStatus.classList.add(type === "success" ? "is-success" : "is-error");
  }
}

function setVoteStatus(message, type) {
  ui.voteStatus.textContent = message;
  ui.voteStatus.classList.remove("is-success", "is-error");

  if (type === "success" || type === "error") {
    ui.voteStatus.classList.add(type === "success" ? "is-success" : "is-error");
  }
}

function setProposalHashBusy(isBusy) {
  ui.proposalHashButton.disabled = isBusy;
  ui.proposalHashButton.textContent = isBusy ? "Verifying..." : "Verify Proposal Hash";
}

function setVoteBusy(isBusy) {
  ui.verifyVoteButton.disabled = isBusy;
  ui.verifyVoteButton.textContent = isBusy ? "Verifying..." : "Verify Vote";
}
