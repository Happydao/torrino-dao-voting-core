const APP_BASE_PATH = "/torrino.dao.voting";
const VERIFY_VOTE_ENDPOINT = `${APP_BASE_PATH}/api/verify-vote-record`;
const textEncoder = new TextEncoder();

const ui = {
  form: document.getElementById("unifiedVerifierForm"),
  proposalHashInput: document.getElementById("verifyProposalHashInput"),
  proposalTitleInput: document.getElementById("verifyProposalTitleInput"),
  proposalDescriptionInput: document.getElementById("verifyProposalDescriptionInput"),
  proposalOptionsInput: document.getElementById("verifyProposalOptionsInput"),
  walletInput: document.getElementById("verifyWalletInput"),
  signedMessageInput: document.getElementById("verifySignedMessageInput"),
  signatureInput: document.getElementById("verifySignatureInput"),
  submitButton: document.getElementById("verifyUnifiedButton"),
  status: document.getElementById("verifyStatus"),
  resultCard: document.getElementById("verifyResultCard"),
  resultBadge: document.getElementById("verifyResultBadge"),
  resultHeadline: document.getElementById("verifyResultHeadline"),
  resultMessage: document.getElementById("verifyResultMessage"),
  resultDetails: document.getElementById("verifyResultDetails"),
  hashResult: document.getElementById("verifyHashResult"),
  signedHashResult: document.getElementById("verifySignedHashResult"),
  signatureResult: document.getElementById("verifySignatureResult"),
  resultPayload: document.getElementById("verifyResultPayload"),
};

ui.form.addEventListener("submit", handleVerification);

async function handleVerification(event) {
  event.preventDefault();

  const proposalPayloadHash = ui.proposalHashInput.value.trim().toLowerCase();
  const proposalTitle = ui.proposalTitleInput.value.trim();
  const proposalDescription = ui.proposalDescriptionInput.value.trim();
  const proposalOptions = parseProposalOptions(ui.proposalOptionsInput.value);
  const wallet = ui.walletInput.value.trim();
  const signedMessage = ui.signedMessageInput.value.trim();
  const signature = ui.signatureInput.value.trim();

  if (!proposalPayloadHash || !proposalTitle || !proposalDescription || proposalOptions.length === 0 || !wallet || !signedMessage || !signature) {
    setStatus("Fill in proposal hash, title, description, options, wallet, signed message and signature.", "error");
    hideResult();
    return;
  }

  try {
    setBusy(true);
    setStatus("Rebuilding proposal hash and verifying signature...", "");
    hideResult();

    const proposalPayload = {
      title: proposalTitle,
      description: proposalDescription,
      options: proposalOptions,
    };
    const calculatedHash = await hashProposalPayload(proposalPayload);
    const proposalHashMatches = calculatedHash === proposalPayloadHash;

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
    const verification = await response.json().catch(() => null);

    if (!response.ok || !verification) {
      throw new Error("SERVER_ERROR");
    }

    renderResult({
      proposalPayload,
      expectedHash: proposalPayloadHash,
      calculatedHash,
      proposalHashMatches,
      signatureVerification: verification,
    });
  } catch (error) {
    console.error(error);
    hideResult();
    setStatus("An error occurred while running the verification.", "error");
  } finally {
    setBusy(false);
  }
}

function renderResult(result) {
  const { proposalPayload, expectedHash, calculatedHash, proposalHashMatches, signatureVerification } = result;
  const signatureValid = Boolean(signatureVerification && signatureVerification.valid);
  const signedMessageHashMatches = signatureValid && signatureVerification.proposal_hash === expectedHash;
  const allChecksValid = proposalHashMatches && signatureValid && signedMessageHashMatches;

  ui.resultCard.hidden = false;
  ui.resultBadge.textContent = "Verification result";
  ui.resultBadge.classList.remove("is-success", "is-error");
  ui.resultHeadline.textContent = allChecksValid ? "TRUE" : "FALSE";
  ui.resultMessage.textContent = allChecksValid
    ? "The proposal data rebuilds the same hash, the signed message contains that same hash, and the wallet signature is valid."
    : "One or more checks failed. Review the hash, signed message and signature details below.";
  ui.resultDetails.textContent = `Proposal hash entered: ${expectedHash || "--"} | Proposal hash rebuilt: ${calculatedHash || "--"}`;
  ui.hashResult.textContent = proposalHashMatches
    ? "Proposal payload check: TRUE. Title, description and options generate the same proposal hash."
    : "Proposal payload check: FALSE. Title, description and options do not generate the same proposal hash.";
  ui.signedHashResult.textContent = signatureValid
    ? signedMessageHashMatches
      ? `Signed message hash check: TRUE. The signed message contains the same proposal hash: ${signatureVerification.proposal_hash}.`
      : `Signed message hash check: FALSE. The signed message contains ${signatureVerification.proposal_hash || "--"} instead of ${expectedHash}.`
    : `Signed message hash check: FALSE. ${getVoteVerificationFailureMessage(signatureVerification.reason)}`;
  ui.signatureResult.textContent = signatureValid
    ? `Signature check: TRUE. Wallet ${signatureVerification.wallet} really signed this message. Vote option: ${signatureVerification.vote_option}.`
    : `Signature check: FALSE. ${getVoteVerificationFailureMessage(signatureVerification.reason)}`;
  ui.resultPayload.textContent = JSON.stringify(proposalPayload, null, 2);
  ui.resultBadge.classList.add(allChecksValid ? "is-success" : "is-error");

  setStatus(
    allChecksValid
      ? "Verification completed successfully."
      : "Verification completed. At least one check failed.",
    allChecksValid ? "success" : "error"
  );
}

function hideResult() {
  ui.resultCard.hidden = true;
}

function setStatus(message, type) {
  ui.status.textContent = message;
  ui.status.classList.remove("is-success", "is-error");

  if (type === "success" || type === "error") {
    ui.status.classList.add(type === "success" ? "is-success" : "is-error");
  }
}

function setBusy(isBusy) {
  ui.submitButton.disabled = isBusy;
  ui.submitButton.textContent = isBusy ? "Checking..." : "Run Verification";
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
    return "This signed message does not contain a proposal hash.";
  }

  if (reason === "PROPOSAL_HASH_MISMATCH") {
    return "The proposal hash inside the signed message does not match the proposal hash you entered.";
  }

  return "The vote could not be verified.";
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
