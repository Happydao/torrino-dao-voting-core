const APP_BASE_PATH = "/torrino.dao.voting";
const VERIFY_VOTE_ENDPOINT = `${APP_BASE_PATH}/api/verify-vote-record`;
const textEncoder = new TextEncoder();

const ui = {
  proposalHashForm: document.getElementById("proposalHashVerifierForm"),
  proposalHashInput: document.getElementById("verifyProposalHashInput"),
  proposalTitleInput: document.getElementById("verifyProposalTitleInput"),
  proposalDescriptionInput: document.getElementById("verifyProposalDescriptionInput"),
  proposalOptionsInput: document.getElementById("verifyProposalOptionsInput"),
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
  const proposalTitle = ui.proposalTitleInput.value.trim();
  const proposalDescription = ui.proposalDescriptionInput.value.trim();
  const proposalOptions = parseProposalOptions(ui.proposalOptionsInput.value);

  if (!proposalPayloadHash || !proposalTitle || !proposalDescription || proposalOptions.length === 0) {
    setProposalHashStatus("Fill in proposal_payload_hash, title, description and at least one option.", "error");
    hideProposalHashResult();
    return;
  }

  try {
    setProposalHashBusy(true);
    setProposalHashStatus("Rebuilding proposal hash...", "");
    hideProposalHashResult();

    const proposalPayload = {
      title: proposalTitle,
      description: proposalDescription,
      options: proposalOptions,
    };
    const calculatedHash = await hashProposalPayload(proposalPayload);
    const matches = calculatedHash === proposalPayloadHash;

    renderProposalHashResult({
      valid: matches,
      expected_hash: proposalPayloadHash,
      calculated_hash: calculatedHash,
      proposal_payload: proposalPayload,
    });
    setProposalHashStatus(
      matches
        ? "Proposal hash rebuilt successfully. It matches the CSV hash you entered."
        : "The rebuilt proposal hash does not match the proposal_payload_hash you entered.",
      matches ? "success" : "error"
    );

    ui.proposalHashForVote.value = proposalPayloadHash;
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
    ? "The title, description and options you entered generate the same proposal hash written in the CSV."
    : "The title, description and options you entered do not generate the same proposal hash written in the CSV.";
  ui.proposalHashResultDetails.textContent = `Entered hash: ${result.expected_hash || "--"} | Calculated hash: ${result.calculated_hash || "--"}`;
  ui.proposalHashResultPayload.textContent = JSON.stringify(result.proposal_payload, null, 2);
  ui.proposalHashResultBadge.classList.add(result.valid ? "is-success" : "is-error");
}

function renderVoteVerificationResult(result) {
  ui.voteResultCard.hidden = false;
  ui.voteResultBadge.textContent = "Vote verification result";
  ui.voteResultBadge.classList.remove("is-success", "is-error");
  ui.voteResultHeadline.textContent = result.valid ? "TRUE" : "FALSE";
  ui.voteResultMessage.textContent = result.valid
    ? "The signature is valid, and the signed message contains the same proposal hash you entered."
    : getVoteVerificationFailureMessage(result.reason);
  ui.voteResultDetails.textContent = result.valid
    ? `Wallet: ${result.wallet} | Proposal hash in signed message: ${result.proposal_hash || "--"} | Vote option: ${result.vote_option}`
    : `Reason: ${result.reason || "UNKNOWN_ERROR"}`;
  ui.voteResultBadge.classList.add(result.valid ? "is-success" : "is-error");
}

function hideProposalHashResult() {
  ui.proposalHashResultCard.hidden = true;
}

function hideVoteResult() {
  ui.voteResultCard.hidden = true;
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

  if (reason === "PROPOSAL_HASH_MISMATCH") {
    return "The proposal hash inside the signed message does not match the proposal hash you entered.";
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
  ui.proposalHashButton.textContent = isBusy ? "Rebuilding..." : "Rebuild Proposal Hash";
}

function setVoteBusy(isBusy) {
  ui.verifyVoteButton.disabled = isBusy;
  ui.verifyVoteButton.textContent = isBusy ? "Verifying..." : "Verify Vote";
}

async function hashProposalPayload(proposalPayload) {
  const normalizedPayload = {
    title: String(proposalPayload && proposalPayload.title ? proposalPayload.title : ""),
    description: String(proposalPayload && proposalPayload.description ? proposalPayload.description : ""),
    options: Array.isArray(proposalPayload && proposalPayload.options)
      ? proposalPayload.options.map((option) => String(option || ""))
      : [],
  };
  const payloadText = JSON.stringify(normalizedPayload);
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(payloadText));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseProposalOptions(rawValue) {
  return String(rawValue || "")
    .split("\n")
    .flatMap((line) => line.split("|"))
    .map((option) => option.trim())
    .filter(Boolean);
}
