const APP_BASE_PATH = "/torrino.dao.voting";
const VERIFY_ENDPOINT = `${APP_BASE_PATH}/api/verify-vote-record`;

const ui = {
  form: document.getElementById("voteVerifierForm"),
  wallet: document.getElementById("verifyWalletInput"),
  signedMessage: document.getElementById("verifySignedMessageInput"),
  signature: document.getElementById("verifySignatureInput"),
  verifyButton: document.getElementById("verifyVoteButton"),
  status: document.getElementById("verifyStatus"),
  resultCard: document.getElementById("verifyResultCard"),
  resultBadge: document.getElementById("verifyResultBadge"),
  resultHeadline: document.getElementById("verifyResultHeadline"),
  resultMessage: document.getElementById("verifyResultMessage"),
  resultDetails: document.getElementById("verifyResultDetails"),
};

ui.form.addEventListener("submit", handleVoteVerification);

async function handleVoteVerification(event) {
  event.preventDefault();

  const wallet = ui.wallet.value.trim();
  const signedMessage = ui.signedMessage.value.trim();
  const signature = ui.signature.value.trim();

  if (!wallet || !signedMessage || !signature) {
    setVerifierStatus("Fill in wallet, signed message and signature.", "error");
    hideVerifierResult();
    return;
  }

  try {
    setVerifierBusy(true);
    setVerifierStatus("Verifying vote signature...", "");
    hideVerifierResult();

    const response = await fetch(VERIFY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet,
        signed_message: signedMessage,
        signature,
      }),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      throw new Error("SERVER_ERROR");
    }

    renderVerificationResult(payload);
    setVerifierStatus(payload.valid
      ? "Verification completed successfully."
      : "Verification failed. The row does not match a valid vote signature.", payload.valid ? "success" : "error");
  } catch (error) {
    console.error(error);
    hideVerifierResult();
    setVerifierStatus("An error occurred while verifying the vote.", "error");
  } finally {
    setVerifierBusy(false);
  }
}

function renderVerificationResult(result) {
  ui.resultCard.hidden = false;
  ui.resultBadge.textContent = "Verification result";
  ui.resultBadge.classList.remove("is-success", "is-error");
  ui.resultHeadline.textContent = result.valid ? "TRUE" : "FALSE";
  ui.resultMessage.textContent = result.valid
    ? "The signature is valid. The vote row was signed by the wallet shown in the CSV."
    : getVerificationFailureMessage(result.reason);
  ui.resultDetails.textContent = result.valid
    ? `Wallet: ${result.wallet} | Proposal: ${result.proposal_id || "--"} | Proposal hash: ${result.proposal_hash || "--"} | Vote option: ${result.vote_option}`
    : `Reason: ${result.reason || "UNKNOWN_ERROR"}`;
  ui.resultBadge.classList.add(result.valid ? "is-success" : "is-error");
}

function hideVerifierResult() {
  ui.resultCard.hidden = true;
}

function getVerificationFailureMessage(reason) {
  if (reason === "INVALID_SIGNATURE") {
    return "The signature does not match the wallet and signed message provided.";
  }

  if (reason === "INVALID_MESSAGE_FORMAT") {
    return "The signed message format is not a valid Torrino DAO vote message.";
  }

  if (reason === "MESSAGE_MISMATCH") {
    return "The wallet written inside the signed message does not match the wallet field you entered.";
  }

  return "The vote could not be verified.";
}

function setVerifierStatus(message, type) {
  ui.status.textContent = message;
  ui.status.classList.remove("is-success", "is-error");

  if (type === "success" || type === "error") {
    ui.status.classList.add(type === "success" ? "is-success" : "is-error");
  }
}

function setVerifierBusy(isBusy) {
  ui.verifyButton.disabled = isBusy;
  ui.verifyButton.textContent = isBusy ? "Verifying..." : "Verify Vote";
}
