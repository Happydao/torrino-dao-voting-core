const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { URL } = require("url");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const RPC = process.env.HELIUS_RPC;
const ADMIN_WALLET = process.env.ADMIN_WALLET || "5feimx18jM2hK2rvZnQHRsjhSeCkHAiLeQZDuJkU2fPc";
const SECONDARY_ADMIN_WALLET = "4hcKvjU4EMzz5TSjgk7CMwhTwy4gXTuhdEYHyd5Shaz8";
const AUTHORIZED_ADMIN_WALLETS = new Set([ADMIN_WALLET, SECONDARY_ADMIN_WALLET]);
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const USED_MINTS_PATH = path.join(DATA_DIR, "used-mints.json");
const PROPOSAL_PATH = path.join(DATA_DIR, "proposal.json");
const TORRINO_TOTAL_NFTS = 500;
const SOLNAUTA_TOTAL_NFTS = 888;
const TORRINO_TREASURY_SHARE = 90;
const SOLNAUTA_TREASURY_SHARE = 10;
const TOTAL_VOTING_POWER = TORRINO_TREASURY_SHARE + SOLNAUTA_TREASURY_SHARE;
const GIT_UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const NFT_CACHE_TTL_MS = 45 * 1000;
const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const PROPOSAL_NAME_MAX_LENGTH = 20;
const JSON_BODY_MAX_BYTES = 16 * 1024;
const VOTE_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const ADMIN_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const COLLECTIONS = {
  torrino: {
    name: "Torrino DAO",
    address: "DKaSqu5ftJTkxr9yGyxCakooFZAi2X5aa6SGhs5yR81t",
    weight: TORRINO_TREASURY_SHARE / TORRINO_TOTAL_NFTS,
  },
  solnauta: {
    name: "Solnauta",
    address: "FSKamMRcYWVWxuCzKLofdVSDgwkZ1ufEy99Q9ig3SfG4",
    weight: SOLNAUTA_TREASURY_SHARE / SOLNAUTA_TOTAL_NFTS,
  },
};
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};
const STATIC_ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_TYPES));
const BLOCKED_STATIC_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".gitignore",
  "package-lock.json",
  "package.json",
  "server.js",
]);
const BLOCKED_STATIC_PATH_SEGMENTS = new Set([
  ".git",
  "data",
  "node_modules",
]);
const execFileAsync = promisify(execFile);
const voteSyncState = {
  initialCommitTimeoutId: null,
  intervalId: null,
  startTimeoutId: null,
  endTimeoutId: null,
  proposalId: null,
};
const nftOwnerCache = new Map();
const rateLimitStore = new Map();
let mutationQueue = Promise.resolve();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (isRateLimited(req, requestUrl.pathname)) {
      sendJson(res, 429, { error: "RATE_LIMITED" });
      return;
    }

    if (requestUrl.pathname === "/api/wallet-nfts") {
      await handleWalletNfts(requestUrl, res);
      return;
    }

    if (requestUrl.pathname === "/api/proposal") {
      handleProposal(res);
      return;
    }

    if (requestUrl.pathname === "/api/results") {
      handleResults(res);
      return;
    }

    if (requestUrl.pathname === "/api/vote") {
      await handleVote(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/admin/proposal") {
      await handleAdminProposal(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/admin/reset-voting") {
      await handleAdminReset(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/verify-vote-record") {
      await handleVerifyVoteRecord(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/verify-proposal-hash") {
      await handleVerifyProposalHash(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    serveStaticFile(requestUrl.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    if (error && error.message === "BODY_TOO_LARGE") {
      sendJson(res, 413, { error: "BODY_TOO_LARGE" });
      return;
    }
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
});

server.listen(PORT, () => {
  console.log(`Server in ascolto su http://localhost:${PORT}`);
  restoreVotingSyncTimers();
});

async function handleWalletNfts(requestUrl, res) {
  if (!RPC) {
    sendJson(res, 500, { error: "SERVER_ERROR" });
    return;
  }

  const walletAddress = requestUrl.searchParams.get("address");

  if (!walletAddress) {
    sendJson(res, 400, { error: "SERVER_ERROR" });
    return;
  }

  try {
    const assets = await getCachedAssetsByOwner(walletAddress);
    const session = readProposal();
    sendJson(res, 200, summarizeWalletAssets(assets, getUsedNftState(session), getSessionProposals(session)));
  } catch (error) {
    console.error(error);
    sendJson(res, 502, { error: "SERVER_ERROR" });
  }
}

function handleProposal(res) {
  const session = readProposal();
  const proposals = getSessionProposals(session);

  if (proposals.length === 0) {
    sendJson(res, 200, { proposals: [], status: "inactive", is_voting_open: false });
    return;
  }

  const status = getSessionStatus(session);
  sendJson(res, 200, {
    proposals: proposals.map((proposal) => ({
      ...proposal,
      display_name: getProposalDisplayName(proposal),
      csv_file_name: getProposalCsvFileName(proposal),
      status: getProposalStatus(proposal),
      is_voting_open: getProposalStatus(proposal) === "active",
    })),
    status,
    is_voting_open: status === "active",
  });
}

function handleResults(res) {
  try {
    sendJson(res, 200, calculateResults());
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
}

async function handleVote(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "SERVER_ERROR" });
    return;
  }

  if (!RPC) {
    sendJson(res, 500, { error: "SERVER_ERROR" });
    return;
  }

  const session = readProposal();
  const sessionStatus = getSessionStatus(session);

  if (!session || getSessionProposals(session).length === 0 || sessionStatus === "inactive" || sessionStatus === "ended") {
    sendJson(res, 403, { error: "VOTING_ENDED" });
    return;
  }

  if (sessionStatus === "scheduled") {
    sendJson(res, 403, { error: "VOTING_NOT_STARTED" });
    return;
  }

  const body = await readJsonBody(req);
  const proposalId = getString(body.proposal_id);
  const wallet = getString(body.wallet);
  const vote = getString(body.vote);
  const signature = getString(body.signature) || "not-signed";
  const signedMessage = getString(body.signed_message);
  const proposal = findProposalById(session, proposalId);
  const proposalStatus = proposal ? getProposalStatus(proposal) : "inactive";

  if (!proposal || !wallet || !vote || !proposal.options.includes(vote)) {
    sendJson(res, 400, { error: "SERVER_ERROR" });
    return;
  }

  if (proposalStatus !== "active") {
    sendJson(res, 403, { error: proposalStatus === "ended" ? "VOTING_ENDED" : "VOTING_NOT_STARTED" });
    return;
  }

  if (!verifyVoteRequest(wallet, proposalId, vote, signedMessage, signature)) {
    sendJson(res, 403, { error: "INVALID_WALLET_SIGNATURE" });
    return;
  }

  try {
    const assets = await getCachedAssetsByOwner(wallet, { forceRefresh: true });
    const result = await withMutationLock(() => {
      ensureVoteStorageFiles(session);
      const summary = summarizeWalletAssets(assets, getUsedNftState(session), getSessionProposals(session));
      const proposalState = Array.isArray(summary.proposal_states)
        ? summary.proposal_states.find((item) => item.proposal_id === proposalId)
        : null;
      const usableGen1Nfts = proposalState ? proposalState.gen1_nfts.filter((nft) => nft.status === "AVAILABLE") : [];
      const usableGen2Nfts = proposalState ? proposalState.gen2_nfts.filter((nft) => nft.status === "AVAILABLE") : [];
      const usableNfts = [...usableGen2Nfts, ...usableGen1Nfts];

      if (usableNfts.length === 0) {
        return null;
      }

      const votingPower = Number(
        formatVotingPowerValue(
          usableGen1Nfts.length * COLLECTIONS.torrino.weight +
          usableGen2Nfts.length * COLLECTIONS.solnauta.weight
        )
      );

      appendVoteRow(proposal, {
        wallet,
        solnautaNfts: usableGen2Nfts.map((nft) => nft.mint),
        torrinoNfts: usableGen1Nfts.map((nft) => nft.mint),
        vote,
        votingPower,
        timestamp: Math.floor(Date.now() / 1000),
        signedMessage,
        signature,
      });
      registerUsedMints(proposalId, usableNfts.map((nft) => nft.mint));

      return { votingPower };
    });

    if (!result) {
      sendJson(res, 409, {
        error: "ALL_NFTS_ALREADY_VOTED",
        message: "All NFTs from this wallet have already voted.",
      });
      return;
    }

    sendJson(res, 200, {
      success: true,
      voting_power: result.votingPower,
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
}

async function handleAdminProposal(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "SERVER_ERROR" });
    return;
  }

  const body = await readJsonBody(req);
  const adminWallet = getString(body.admin_wallet);
  const adminSignedMessage = getString(body.admin_signed_message);
  const adminSignature = getString(body.admin_signature);
  const startTime = Number(body.start_time);
  const endTime = Number(body.end_time);
  const proposalInputs = getAdminProposalInputs(body);

  if (!isAuthorizedAdminWallet(adminWallet)) {
    sendJson(res, 403, { error: "UNAUTHORIZED_ADMIN" });
    return;
  }

  if (proposalInputs.length === 0) {
    sendJson(res, 400, { error: "INVALID_PROPOSAL" });
    return;
  }

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    sendJson(res, 400, { error: "INVALID_TIME_RANGE" });
    return;
  }

  if (!verifyAdminActionRequest(adminWallet, adminSignedMessage, adminSignature, {
    action: "start",
    proposalPayload: buildAdminProposalPayload(proposalInputs, startTime, endTime),
  })) {
    sendJson(res, 403, { error: "INVALID_ADMIN_SIGNATURE" });
    return;
  }

  const baseProposalId = Math.floor(Date.now() / 1000);
  const session = {
    proposals: proposalInputs.map((item, index) => ({
      proposal_id: String(baseProposalId + index),
      proposal_name: item.proposal_name,
      created_by: adminWallet,
      created_signed_message: adminSignedMessage,
      created_signature: adminSignature,
      title: item.title,
      description: item.description,
      options: item.options,
      start_time: Math.floor(startTime),
      end_time: Math.floor(endTime),
    })),
  };

  try {
    await withMutationLock(() => {
      const existingSession = readProposal();

      if (existingSession) {
        const existingStatus = getSessionStatus(existingSession);

        if (existingStatus === "active" || existingStatus === "scheduled") {
          const error = new Error("PROPOSAL_ALREADY_ACTIVE");
          error.code = "PROPOSAL_ALREADY_ACTIVE";
          throw error;
        }
      }

      ensureDataDir();
      assertProposalFileNamesAvailable(session);
      for (const proposal of session.proposals) {
        initializeVoteStorageForProposal(proposal, adminWallet);
      }
      writeFileAtomic(USED_MINTS_PATH, JSON.stringify(buildEmptyUsedMintsRegistry(session), null, 2) + "\n");
      writeFileAtomic(PROPOSAL_PATH, JSON.stringify(session, null, 2) + "\n");
      configureVotingSyncTimers(session);
    });
    sendJson(res, 200, { success: true, proposals: session.proposals });
  } catch (error) {
    console.error(error);
    if (error && (error.code === "PROPOSAL_ALREADY_ACTIVE" || error.message === "PROPOSAL_ALREADY_ACTIVE")) {
      sendJson(res, 409, { error: "PROPOSAL_ALREADY_ACTIVE" });
      return;
    }
    if (error && (error.code === "PROPOSAL_FILE_CONFLICT" || error.message === "PROPOSAL_FILE_CONFLICT")) {
      sendJson(res, 409, { error: "PROPOSAL_FILE_CONFLICT" });
      return;
    }
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
}

async function handleAdminReset(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "SERVER_ERROR" });
    return;
  }

  const body = await readJsonBody(req);
  const adminWallet = getString(body.admin_wallet);
  const adminSignedMessage = getString(body.admin_signed_message);
  const adminSignature = getString(body.admin_signature);

  if (!isAuthorizedAdminWallet(adminWallet)) {
    sendJson(res, 403, { error: "UNAUTHORIZED_ADMIN" });
    return;
  }

  const session = readProposal();
  const proposalIds = getSessionProposals(session).map((proposal) => proposal.proposal_id);
  const isValidAdminReset = session
    ? verifyAdminActionRequest(adminWallet, adminSignedMessage, adminSignature, {
      action: "stop",
      proposalIds,
    })
    : verifyWalletSignature(adminWallet, adminSignedMessage, adminSignature);

  if (!isValidAdminReset) {
    sendJson(res, 403, { error: "INVALID_ADMIN_SIGNATURE" });
    return;
  }

  try {
    if (session) {
      await withMutationLock(async () => {
        stopVotingSyncTimers();
        const resetTimestamp = Math.floor(Date.now() / 1000);
        for (const proposal of getSessionProposals(session)) {
          markProposalCsvAsReset(
            proposal,
            adminWallet,
            resetTimestamp,
            adminSignedMessage,
            adminSignature
          );
        }
        await commitVotesCsvToGit(buildLifecycleCommitMessage("stopped", session, adminWallet), {
          session,
          allowStatuses: ["scheduled", "active", "ended"],
          skipMetadataRewrite: true,
        });
      });
    }

    await withMutationLock(() => {
      deleteFileIfExists(USED_MINTS_PATH);
      deleteFileIfExists(PROPOSAL_PATH);
    });

    sendJson(res, 200, { success: true });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
}

async function handleVerifyVoteRecord(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const body = await readJsonBody(req);
  const wallet = getString(body.wallet);
  const signedMessage = getString(body.signed_message);
  const signature = getString(body.signature);
  const proposalPayloadHash = getString(body.proposal_payload_hash).toLowerCase();
  const verification = verifyVoteRecordSignature(wallet, signedMessage, signature);

  if (verification.valid && proposalPayloadHash) {
    if (!verification.proposal_hash) {
      sendJson(res, 200, {
        ...verification,
        valid: false,
        reason: "PROPOSAL_HASH_MISSING",
      });
      return;
    }

    if (verification.proposal_hash !== proposalPayloadHash) {
      sendJson(res, 200, {
        ...verification,
        valid: false,
        reason: "PROPOSAL_HASH_MISMATCH",
      });
      return;
    }
  }

  sendJson(res, 200, verification);
}

async function handleVerifyProposalHash(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const body = await readJsonBody(req);
  const proposalPayloadHash = getString(body.proposal_payload_hash).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(proposalPayloadHash)) {
    sendJson(res, 400, { error: "INVALID_PROPOSAL_HASH" });
    return;
  }

  try {
    const match = findProposalByPayloadHash(proposalPayloadHash);

    if (!match) {
      sendJson(res, 200, { valid: false, reason: "PROPOSAL_HASH_NOT_FOUND" });
      return;
    }

    sendJson(res, 200, {
      valid: true,
      proposal_payload_hash: proposalPayloadHash,
      csv_file_name: match.csv_file_name,
      proposal_payload: buildProposalPayloadForHash(match.proposal),
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
}

async function getAllAssetsByOwner(ownerAddress) {
  const items = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const payload = {
      jsonrpc: "2.0",
      id: `wallet-nfts-${page}`,
      method: "getAssetsByOwner",
      params: {
        ownerAddress,
        page,
        limit,
      },
    };
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`RPC request failed with status ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || "RPC returned an error");
    }

    const pageItems = Array.isArray(data.result && data.result.items) ? data.result.items : [];
    items.push(...pageItems);

    if (pageItems.length < limit) {
      break;
    }

    page += 1;
  }

  return items;
}

async function getCachedAssetsByOwner(ownerAddress, options = {}) {
  const cacheKey = String(ownerAddress || "").trim();
  const forceRefresh = options.forceRefresh === true;

  if (!cacheKey) {
    return [];
  }

  const now = Date.now();
  cleanupNftCache(now);

  const cachedEntry = nftOwnerCache.get(cacheKey);
  if (!forceRefresh && cachedEntry && cachedEntry.expiresAt > now && Array.isArray(cachedEntry.items)) {
    return cachedEntry.items;
  }

  if (!forceRefresh && cachedEntry && cachedEntry.inFlightPromise) {
    return cachedEntry.inFlightPromise;
  }

  const inFlightPromise = getAllAssetsByOwner(cacheKey)
    .then((items) => {
      nftOwnerCache.set(cacheKey, {
        items,
        expiresAt: Date.now() + NFT_CACHE_TTL_MS,
        inFlightPromise: null,
      });
      return items;
    })
    .catch((error) => {
      nftOwnerCache.delete(cacheKey);
      throw error;
    });

  nftOwnerCache.set(cacheKey, {
    items: cachedEntry && Array.isArray(cachedEntry.items) ? cachedEntry.items : null,
    expiresAt: 0,
    inFlightPromise,
  });

  return inFlightPromise;
}

function cleanupNftCache(now = Date.now()) {
  for (const [cacheKey, entry] of nftOwnerCache.entries()) {
    if (!entry) {
      nftOwnerCache.delete(cacheKey);
      continue;
    }

    if (!entry.inFlightPromise && entry.expiresAt <= now) {
      nftOwnerCache.delete(cacheKey);
    }
  }
}

function summarizeWalletAssets(assets, usedState, proposals = []) {
  const gen1Names = [];
  const gen2Names = [];
  const gen1Mints = [];
  const gen2Mints = [];
  const gen1Nfts = [];
  const gen2Nfts = [];
  const usedMintsByProposal = usedState && usedState.usedMintsByProposal
    ? usedState.usedMintsByProposal
    : new Map();

  for (const asset of assets) {
    const assetName = getAssetName(asset);
    const assetMint = getAssetMint(asset);
    const usedInProposals = proposals
      .filter((proposal) => {
        const usedMints = usedMintsByProposal.get(proposal.proposal_id) || new Set();
        return usedMints.has(assetMint);
      })
      .map((proposal) => ({
        proposal_id: proposal.proposal_id,
        label: getProposalCsvFileName(proposal),
      }));
    const usedInProposalIds = usedInProposals.map((proposal) => proposal.proposal_id);
    const assetStatus = formatNftUsageStatus(usedInProposals.map((proposal) => proposal.label));

    if (assetBelongsToCollection(asset, COLLECTIONS.torrino.address)) {
      gen1Names.push(assetName);
      gen1Mints.push(assetMint);
      gen1Nfts.push({ mint: assetMint, name: assetName, status: assetStatus, used_in_proposals: usedInProposalIds });
    } else if (assetBelongsToCollection(asset, COLLECTIONS.solnauta.address)) {
      gen2Names.push(assetName);
      gen2Mints.push(assetMint);
      gen2Nfts.push({ mint: assetMint, name: assetName, status: assetStatus, used_in_proposals: usedInProposalIds });
    }
  }

  const gen1Count = gen1Nfts.length;
  const gen2Count = gen2Nfts.length;
  const availableGen1Count = gen1Count;
  const availableGen2Count = gen2Count;
  const votingPower = Number(
    formatVotingPowerValue(gen1Count * COLLECTIONS.torrino.weight + gen2Count * COLLECTIONS.solnauta.weight)
  );
  const proposalStates = proposals.map((proposal) => {
    const proposalGen1Nfts = gen1Nfts.map((nft) => ({
      ...nft,
      status: nft.used_in_proposals.includes(proposal.proposal_id) ? "USED" : "AVAILABLE",
    }));
    const proposalGen2Nfts = gen2Nfts.map((nft) => ({
      ...nft,
      status: nft.used_in_proposals.includes(proposal.proposal_id) ? "USED" : "AVAILABLE",
    }));
    const proposalAvailableGen1Count = proposalGen1Nfts.filter((nft) => nft.status === "AVAILABLE").length;
    const proposalAvailableGen2Count = proposalGen2Nfts.filter((nft) => nft.status === "AVAILABLE").length;

    return {
      proposal_id: proposal.proposal_id,
      gen1_available_count: proposalAvailableGen1Count,
      gen2_available_count: proposalAvailableGen2Count,
      gen1_nfts: proposalGen1Nfts,
      gen2_nfts: proposalGen2Nfts,
      voting_power: Number(
        formatVotingPowerValue(
          proposalAvailableGen1Count * COLLECTIONS.torrino.weight +
          proposalAvailableGen2Count * COLLECTIONS.solnauta.weight
        )
      ),
    };
  });

  return {
    gen1_count: gen1Count,
    gen2_count: gen2Count,
    gen1_available_count: availableGen1Count,
    gen2_available_count: availableGen2Count,
    gen1_names: gen1Names,
    gen2_names: gen2Names,
    gen1_mints: gen1Mints,
    gen2_mints: gen2Mints,
    gen1_nfts: gen1Nfts,
    gen2_nfts: gen2Nfts,
    voting_power: votingPower,
    proposal_states: proposalStates,
  };
}

function calculateResults() {
  const session = readProposal();
  const proposals = getSessionProposals(session);

  return {
    status: getSessionStatus(session),
    results: proposals.map((proposal) => calculateProposalResults(proposal)),
  };
}

function calculateProposalResults(proposal) {
  const baseResults = {
    proposal_id: proposal ? proposal.proposal_id : null,
    display_name: proposal ? getProposalDisplayName(proposal) : "",
    csv_file_name: proposal ? getProposalCsvFileName(proposal) : "",
    status: proposal ? getProposalStatus(proposal) : "inactive",
    solnauta_voted: 0,
    torrino_voted: 0,
    total_power: 0,
    option_results: proposal
      ? proposal.options.map((option) => ({ option, power: 0, percent: 0 }))
      : [],
  };

  const proposalCsvPath = getProposalCsvPath(proposal);

  if (!proposal || !proposalCsvPath || !fs.existsSync(proposalCsvPath)) {
    return baseResults;
  }

  const csvData = readVotesCsv(proposal);
  const lines = csvData.rows;
  const optionColumns = proposal.options;

  if (lines.length <= 1) {
    return baseResults;
  }

  const optionTotals = new Map(proposal.options.map((option) => [option, 0]));
  let solnautaVoted = 0;
  let torrinoVoted = 0;
  let totalPower = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const row = parseVoteCsvLine(lines[index], csvData.header);
    const votingPower = Number.parseFloat(row.voting_power || "0") || 0;

    solnautaVoted += splitStoredNftValues(row.solnauta_nfts).length;
    torrinoVoted += splitStoredNftValues(row.torrino_nfts).length;
    totalPower += votingPower;

    for (let optionIndex = 0; optionIndex < proposal.options.length; optionIndex += 1) {
      const option = proposal.options[optionIndex];
      const columnName = optionColumns[optionIndex];
      const optionPower = Number.parseFloat(row[columnName] || "0") || 0;
      optionTotals.set(option, optionTotals.get(option) + optionPower);
    }
  }

  return {
    proposal_id: proposal.proposal_id,
    display_name: getProposalDisplayName(proposal),
    csv_file_name: getProposalCsvFileName(proposal),
    status: getProposalStatus(proposal),
    solnauta_voted: solnautaVoted,
    torrino_voted: torrinoVoted,
    total_power: Number(formatDecimal(totalPower)),
    option_results: proposal.options.map((option) => {
      const power = optionTotals.get(option) || 0;
      const percent = totalPower > 0 ? Math.round((power / totalPower) * 100) : 0;

      return {
        option,
        power: Number(formatDecimal(power)),
        percent,
      };
    }),
  };
}

function formatNftUsageStatus(usedInProposalLabels) {
  if (!Array.isArray(usedInProposalLabels) || usedInProposalLabels.length === 0) {
    return "AVAILABLE";
  }

  if (usedInProposalLabels.length === 1) {
    return `USED IN PROPOSAL ${usedInProposalLabels[0]}`;
  }

  return `USED IN PROPOSALS ${usedInProposalLabels.join(", ")}`;
}

function assetBelongsToCollection(asset, collectionId) {
  const grouping = Array.isArray(asset.grouping) ? asset.grouping : [];

  for (const group of grouping) {
    if (group && typeof group.group_value === "string" && group.group_value === collectionId) {
      return true;
    }
  }

  const metadataCollection = asset.content &&
    asset.content.metadata &&
    asset.content.metadata.collection &&
    asset.content.metadata.collection.key;

  return typeof metadataCollection === "string" && metadataCollection === collectionId;
}

function getAssetName(asset) {
  const name = asset.content &&
    asset.content.metadata &&
    asset.content.metadata.name;

  return typeof name === "string" && name.trim() ? name.trim() : "Unnamed NFT";
}

function getAssetMint(asset) {
  return asset && typeof asset.id === "string" && asset.id.trim() ? asset.id.trim() : "unknown-mint";
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function resetVoteStorage(createFreshFiles) {
  ensureDataDir();
  const session = readProposal();
  const proposals = getSessionProposals(session);

  if (createFreshFiles && proposals.length > 0) {
    for (const proposal of proposals) {
      writeFileAtomic(getProposalCsvPath(proposal), getVotesCsvHeader(proposal));
    }
    writeFileAtomic(USED_MINTS_PATH, JSON.stringify(buildEmptyUsedMintsRegistry(session), null, 2) + "\n");
    return;
  }

  for (const proposal of proposals) {
    const proposalCsvPath = getProposalCsvPath(proposal);

    if (proposalCsvPath && !fs.existsSync(proposalCsvPath)) {
      writeFileAtomic(proposalCsvPath, getVotesCsvHeader(proposal));
    }
  }

  if (!fs.existsSync(USED_MINTS_PATH)) {
    writeFileAtomic(USED_MINTS_PATH, JSON.stringify(buildEmptyUsedMintsRegistry(session), null, 2) + "\n");
  }
}

function initializeVoteStorageForProposal(proposal, adminWallet) {
  ensureDataDir();
  const proposalCsvPath = getProposalCsvPath(proposal);
  const fileContents = [
    ...buildProposalMetadataLines(proposal, adminWallet),
    "",
    getVotesCsvHeader(proposal).trimEnd(),
  ].join("\n") + "\n";

  writeFileAtomic(proposalCsvPath, fileContents);
}

function buildProposalMetadataLines(proposal, adminWallet, metadataOptions = {}) {
  const creatorWallet = getString(proposal && proposal.created_by) || adminWallet;
  const creationSignedMessage = getString(proposal && proposal.created_signed_message);
  const creationSignature = getString(proposal && proposal.created_signature);
  const createdTimestamp = Number(proposal.proposal_id) || Math.floor(Date.now() / 1000);
  const startTimestamp = Number(proposal.start_time) || "";
  const endTimestamp = Number(proposal.end_time) || "";
  const resetTimestamp = Number.isFinite(metadataOptions.resetTimestamp)
    ? Math.floor(metadataOptions.resetTimestamp)
    : "";
  const resetWallet = getString(metadataOptions.resetWallet);
  const resetSignedMessage = getString(metadataOptions.resetSignedMessage);
  const resetSignature = getString(metadataOptions.resetSignature);
  const lifecycle = getProposalLifecycleMetadata(proposal, adminWallet, {
    resetTimestamp,
    lifecycleTimestamp: metadataOptions.lifecycleTimestamp,
  });
  const participation = getProposalParticipationMetadata(proposal);
  const resultsSummary = calculateProposalResults(proposal);
  const proposalPayloadHash = hashProposalPayload(proposal);
  const metadataRows = [
    ["proposal_created_by", creatorWallet],
    ["proposal_created_timestamp", createdTimestamp],
    ["proposal_created_iso", formatTimestampIso(createdTimestamp)],
    ["proposal_created_signed_message", creationSignedMessage],
    ["proposal_created_signature", creationSignature],
    ["proposal_lifecycle_status", lifecycle.status],
    ["proposal_lifecycle_updated_timestamp", lifecycle.timestamp],
    ["proposal_lifecycle_updated_iso", formatTimestampIso(lifecycle.timestamp)],
    ["voting_start_timestamp", startTimestamp],
    ["voting_start_iso", formatTimestampIso(startTimestamp)],
    ["voting_end_timestamp", endTimestamp],
    ["voting_end_iso", formatTimestampIso(endTimestamp)],
    ["proposal_reset_by", resetWallet],
    ["proposal_reset_timestamp", resetTimestamp],
    ["proposal_reset_iso", formatTimestampIso(resetTimestamp)],
    ["proposal_reset_signed_message", resetSignedMessage],
    ["proposal_reset_signature", resetSignature],
    ["proposal_name", getProposalDisplayName(proposal)],
    ["proposal_payload_hash", proposalPayloadHash],
    ["proposal_title", proposal.title],
    ["proposal_description", proposal.description],
    ["proposal_options", proposal.options.join(" | ")],
    ["torrino_participation_rate", participation.torrinoParticipationRate],
    ["solnauta_participation_rate", participation.solnautaParticipationRate],
    ["total_voting_power_participation_rate", participation.totalVotingPowerParticipationRate],
    ...resultsSummary.option_results.map((item) => [
      `result_${normalizeProposalResultLabel(item.option)}`,
      `${Number(item.percent || 0).toFixed(2)}%`,
    ]),
  ];

  return metadataRows.map(([label, value]) => `${escapeCsvValue(label)},${escapeCsvValue(value)}`);
}

function markProposalCsvAsReset(proposal, adminWallet, resetTimestamp, resetSignedMessage = "", resetSignature = "") {
  const proposalCsvPath = getProposalCsvPath(proposal);

  if (!proposalCsvPath || !fs.existsSync(proposalCsvPath)) {
    return;
  }

  const allRecords = splitCsvRecords(fs.readFileSync(proposalCsvPath, "utf8"));
  const headerIndex = allRecords.findIndex((record) => record.startsWith("wallet,"));
  const voteSectionLines = headerIndex === -1
    ? [getVotesCsvHeader(proposal).trimEnd()]
    : allRecords.slice(headerIndex).filter(Boolean);
  const nextFileContents = [
    ...buildProposalMetadataLines(proposal, adminWallet, {
      resetWallet: adminWallet,
      resetTimestamp,
      resetSignedMessage,
      resetSignature,
    }),
    "",
    ...voteSectionLines,
  ].join("\n") + "\n";

  writeFileAtomic(proposalCsvPath, nextFileContents);
}

function ensureVoteStorageFiles(session = readProposal()) {
  ensureDataDir();

  if (!fs.existsSync(USED_MINTS_PATH)) {
    writeFileAtomic(USED_MINTS_PATH, JSON.stringify(buildEmptyUsedMintsRegistry(session), null, 2) + "\n");
  }

  for (const proposal of getSessionProposals(session)) {
    const proposalCsvPath = getProposalCsvPath(proposal);

    if (proposalCsvPath && !fs.existsSync(proposalCsvPath)) {
      initializeVoteStorageForProposal(proposal, ADMIN_WALLET);
    }
  }
}

function appendVoteRow(proposal, row) {
  const proposalCsvPath = getProposalCsvPath(proposal);
  const optionValues = getOptionColumns(proposal).map((optionLabel) => {
    return escapeCsvValue(formatDecimal(optionLabel === row.vote ? row.votingPower : 0));
  });
  const solnautaMints = row.solnautaNfts.join("\n");
  const torrinoMints = row.torrinoNfts.join("\n");
  const csvLine = [
    escapeCsvValue(row.wallet),
    escapeCsvValue(solnautaMints),
    escapeCsvValue(torrinoMints),
    ...optionValues,
    escapeCsvValue(formatDecimal(row.votingPower)),
    escapeCsvValue(String(row.timestamp)),
    escapeCsvValue(row.signedMessage || ""),
    escapeCsvValue(row.signature),
  ].join(",") + "\n";

  fs.appendFileSync(proposalCsvPath, csvLine, "utf8");
}

function rewriteProposalMetadata(proposal, adminWallet, metadataOptions = {}) {
  const proposalCsvPath = getProposalCsvPath(proposal);

  if (!proposalCsvPath || !fs.existsSync(proposalCsvPath)) {
    return;
  }

  const allRecords = splitCsvRecords(fs.readFileSync(proposalCsvPath, "utf8"));
  const headerIndex = allRecords.findIndex((record) => record.startsWith("wallet,"));
  const voteSectionLines = headerIndex === -1
    ? [getVotesCsvHeader(proposal).trimEnd()]
    : allRecords.slice(headerIndex).filter(Boolean);
  const nextFileContents = [
    ...buildProposalMetadataLines(proposal, adminWallet, metadataOptions),
    "",
    ...voteSectionLines,
  ].join("\n") + "\n";

  writeFileAtomic(proposalCsvPath, nextFileContents);
}

function readUsedMintsRegistry() {
  if (!fs.existsSync(USED_MINTS_PATH)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(USED_MINTS_PATH, "utf8"));
    return normalizeUsedMintsRegistry(parsed, readProposal());
  } catch (error) {
    console.error("Impossibile leggere used-mints.json", error);
    return {};
  }
}

function registerUsedMints(proposalId, mints) {
  const currentMints = readUsedMintsRegistry();
  const nextProposalMints = new Set(Array.isArray(currentMints[proposalId]) ? currentMints[proposalId].filter(isValidMint) : []);

  for (const mint of mints) {
    if (isValidMint(mint)) {
      nextProposalMints.add(mint);
    }
  }

  currentMints[proposalId] = Array.from(nextProposalMints).sort();
  writeFileAtomic(USED_MINTS_PATH, JSON.stringify(currentMints, null, 2) + "\n");
}

function isValidMint(value) {
  return typeof value === "string" && value.trim() && value !== "unknown-mint";
}

function isAuthorizedAdminWallet(walletAddress) {
  return typeof walletAddress === "string" && AUTHORIZED_ADMIN_WALLETS.has(walletAddress);
}

function verifyAdminActionRequest(walletAddress, signedMessage, signature, options = {}) {
  if (!verifyWalletSignature(walletAddress, signedMessage, signature)) {
    return false;
  }

  const action = getString(options.action);

  if (action === "start") {
    const match = signedMessage.match(
      /^Torrino DAO admin action:start:wallet:([1-9A-HJ-NP-Za-km-z]+):payload_hash:([a-f0-9]{64}):timestamp:(\d+)$/
    );

    if (!match) {
      return false;
    }

    const [, signedWalletAddress, signedPayloadHash, signedTimestamp] = match;
    const timestampMs = Number(signedTimestamp);
    const expectedPayloadHash = hashAdminProposalPayload(options.proposalPayload);

    return (
      signedWalletAddress === walletAddress &&
      signedPayloadHash === expectedPayloadHash &&
      Number.isFinite(timestampMs) &&
      Math.abs(Date.now() - timestampMs) <= ADMIN_SIGNATURE_MAX_AGE_MS
    );
  }

  if (action === "stop") {
    const match = signedMessage.match(
      /^Torrino DAO admin action:stop:wallet:([1-9A-HJ-NP-Za-km-z]+):proposals:([^:]+):timestamp:(\d+)$/
    );

    if (!match) {
      return false;
    }

    const [, signedWalletAddress, signedProposalIds, signedTimestamp] = match;
    const timestampMs = Number(signedTimestamp);
    const expectedProposalIds = Array.isArray(options.proposalIds) ? options.proposalIds.join("|") : "";

    return (
      signedWalletAddress === walletAddress &&
      signedProposalIds === expectedProposalIds &&
      Number.isFinite(timestampMs) &&
      Math.abs(Date.now() - timestampMs) <= ADMIN_SIGNATURE_MAX_AGE_MS
    );
  }

  return false;
}

function verifyVoteRequest(walletAddress, proposalId, voteOption, signedMessage, signature) {
  const verification = verifyVoteRecordSignature(walletAddress, signedMessage, signature);
  const session = readProposal();
  const proposal = findProposalById(session, proposalId);
  const acceptedProposalReferences = new Set([proposalId]);
  const expectedProposalHash = proposal ? hashProposalPayload(proposal) : "";

  if (proposal) {
    acceptedProposalReferences.add(getProposalCsvFileName(proposal));
    acceptedProposalReferences.add(getProposalDisplayName(proposal));
  }

  if (
    !verification.valid ||
    !acceptedProposalReferences.has(verification.proposal_id) ||
    (verification.proposal_hash && expectedProposalHash && verification.proposal_hash !== expectedProposalHash) ||
    verification.vote_option !== voteOption ||
    !Number.isFinite(verification.timestamp_ms) ||
    Math.abs(Date.now() - verification.timestamp_ms) > VOTE_SIGNATURE_MAX_AGE_MS
  ) {
    return false;
  }

  return true;
}

function verifyVoteRecordSignature(walletAddress, signedMessage, signature) {
  if (!verifyWalletSignature(walletAddress, signedMessage, signature)) {
    return {
      valid: false,
      wallet: walletAddress,
      vote_option: "",
      timestamp_ms: NaN,
      reason: "INVALID_SIGNATURE",
    };
  }

  const voteMatch = signedMessage.match(
    /^Torrino DAO governance vote:proposal:([^:]+):proposal_hash:([a-f0-9]{64}):option:(.+):wallet:([1-9A-HJ-NP-Za-km-z]+):timestamp:(\d+)$/
  );

  if (voteMatch) {
    const [, signedProposalId, signedProposalHash, signedVoteOption, signedWalletAddress, signedTimestamp] = voteMatch;
    const timestampMs = Number(signedTimestamp);

    if (signedWalletAddress !== walletAddress || !Number.isFinite(timestampMs)) {
      return {
        valid: false,
        wallet: walletAddress,
        proposal_id: signedProposalId,
        proposal_hash: signedProposalHash,
        vote_option: signedVoteOption,
        timestamp_ms: timestampMs,
        reason: "MESSAGE_MISMATCH",
      };
    }

    return {
      valid: true,
      wallet: signedWalletAddress,
      proposal_id: signedProposalId,
      proposal_hash: signedProposalHash,
      vote_option: signedVoteOption,
      timestamp_ms: timestampMs,
      reason: "",
    };
  }

  const legacyVoteMatch = signedMessage.match(
    /^Torrino DAO governance vote:(.+):wallet:([1-9A-HJ-NP-Za-km-z]+):timestamp:(\d+)$/
  );

  if (!legacyVoteMatch) {
    return {
      valid: false,
      wallet: walletAddress,
      proposal_id: "",
      proposal_hash: "",
      vote_option: "",
      timestamp_ms: NaN,
      reason: "INVALID_MESSAGE_FORMAT",
    };
  }

  const [, signedVoteOption, signedWalletAddress, signedTimestamp] = legacyVoteMatch;
  const timestampMs = Number(signedTimestamp);

  if (signedWalletAddress !== walletAddress || !Number.isFinite(timestampMs)) {
    return {
      valid: false,
      wallet: walletAddress,
      proposal_id: "",
      proposal_hash: "",
      vote_option: signedVoteOption,
      timestamp_ms: timestampMs,
      reason: "MESSAGE_MISMATCH",
    };
  }

  return {
    valid: true,
    wallet: signedWalletAddress,
    proposal_id: "",
    proposal_hash: "",
    vote_option: signedVoteOption,
    timestamp_ms: timestampMs,
    reason: "",
  };
}

function verifyWalletSignature(walletAddress, message, signature) {
  if (!walletAddress || !message || !signature || signature === "not-signed") {
    return false;
  }

  try {
    const publicKeyBytes = decodeBase58(walletAddress);
    const signatureBytes = decodeBase58(signature);

    if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) {
      return false;
    }

    const publicKeyDerPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKeyObject = crypto.createPublicKey({
      key: Buffer.concat([publicKeyDerPrefix, publicKeyBytes]),
      format: "der",
      type: "spki",
    });

    return crypto.verify(null, Buffer.from(message, "utf8"), publicKeyObject, signatureBytes);
  } catch (error) {
    return false;
  }
}

function decodeBase58(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const alphabetMap = new Map(alphabet.split("").map((character, index) => [character, index]));
  let decodedValue = 0n;

  for (const character of String(value)) {
    const alphabetIndex = alphabetMap.get(character);

    if (alphabetIndex === undefined) {
      throw new Error("INVALID_BASE58");
    }

    decodedValue = decodedValue * 58n + BigInt(alphabetIndex);
  }

  const bytes = [];

  while (decodedValue > 0n) {
    bytes.push(Number(decodedValue % 256n));
    decodedValue /= 256n;
  }

  let leadingZeroes = 0;

  for (const character of String(value)) {
    if (character === alphabet[0]) {
      leadingZeroes += 1;
      continue;
    }

    break;
  }

  return Buffer.from([
    ...new Array(leadingZeroes).fill(0),
    ...bytes.reverse(),
  ]);
}

function hashAdminProposalPayload(proposalPayload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(buildAdminProposalPayload(
      Array.isArray(proposalPayload && proposalPayload.proposals)
        ? proposalPayload.proposals
        : [],
      Number(proposalPayload && proposalPayload.start_time),
      Number(proposalPayload && proposalPayload.end_time)
    )))
    .digest("hex");
}

function buildAdminProposalPayload(proposals, startTime, endTime) {
  return {
    proposals: Array.isArray(proposals)
      ? proposals.map((proposal) => ({
        proposal_name: normalizeProposalName(proposal && proposal.proposal_name),
        title: getString(proposal && proposal.title),
        description: getString(proposal && proposal.description),
        options: Array.isArray(proposal && proposal.options)
          ? proposal.options.map(getString).filter(Boolean).slice(0, 5)
          : [],
      })).filter((proposal) => proposal.proposal_name && proposal.title && proposal.description && proposal.options.length > 0).slice(0, 2)
      : [],
    start_time: Number(startTime),
    end_time: Number(endTime),
  };
}

function getAdminProposalInputs(body) {
  if (Array.isArray(body && body.proposals)) {
    const normalized = body.proposals
      .map((proposal) => ({
        proposal_name: normalizeProposalName(proposal && proposal.proposal_name),
        title: getString(proposal && proposal.title),
        description: getString(proposal && proposal.description),
        options: Array.isArray(proposal && proposal.options)
          ? proposal.options.map(getString).filter(Boolean).slice(0, 5)
          : [],
      }))
      .filter((proposal) => proposal.proposal_name || proposal.title || proposal.description || proposal.options.length > 0)
      .slice(0, 2);

    if (normalized.some((proposal) => !proposal.proposal_name || !proposal.title || !proposal.description || proposal.options.length === 0)) {
      return [];
    }

    const uniqueNames = new Set(normalized.map((proposal) => proposal.proposal_name));
    if (uniqueNames.size !== normalized.length) {
      return [];
    }

    return normalized;
  }

  const legacyTitle = getString(body && body.title);
  const legacyDescription = getString(body && body.description);
  const legacyOptions = Array.isArray(body && body.options)
    ? body.options.map(getString).filter(Boolean).slice(0, 5)
    : [];

  return legacyTitle && legacyDescription && legacyOptions.length > 0
    ? [{ title: legacyTitle, description: legacyDescription, options: legacyOptions }]
    : [];
}

function readProposal() {
  if (!fs.existsSync(PROPOSAL_PATH)) {
    return null;
  }

  try {
    return normalizeVotingSession(JSON.parse(fs.readFileSync(PROPOSAL_PATH, "utf8")));
  } catch (error) {
    console.error("Impossibile leggere proposal.json", error);
    return null;
  }
}

function normalizeVotingSession(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value.proposals)) {
    const proposals = value.proposals
      .map((proposal) => normalizeSessionProposal(proposal, value))
      .filter(Boolean)
      .slice(0, 2);

    if (proposals.length === 0) {
      return null;
    }

    return {
      proposals,
    };
  }

  if (value.proposal_id) {
    const proposal = normalizeSessionProposal(value, value);

    return proposal
      ? { proposals: [proposal] }
      : null;
  }

  return null;
}

function normalizeSessionProposal(proposal, parent = {}) {
  if (!proposal || typeof proposal !== "object") {
    return null;
  }

  const proposalId = getString(proposal.proposal_id);
  const proposalName = normalizeProposalName(proposal.proposal_name) || normalizeProposalName(proposal.display_name);
  const title = getString(proposal.title);
  const description = getString(proposal.description);
  const options = Array.isArray(proposal.options)
    ? proposal.options.map(getString).filter(Boolean).slice(0, 5)
    : [];
  const startTime = Number(proposal.start_time ?? parent.start_time);
  const endTime = Number(proposal.end_time ?? parent.end_time);

  if (!proposalId || !title || !description || options.length === 0) {
    return null;
  }

  return {
    ...proposal,
    proposal_id: proposalId,
    proposal_name: proposalName,
    title,
    description,
    options,
    start_time: Math.floor(startTime),
    end_time: Math.floor(endTime),
  };
}

function getSessionProposals(session) {
  return session && Array.isArray(session.proposals) ? session.proposals : [];
}

function getSessionStatus(session) {
  const proposals = getSessionProposals(session);

  if (proposals.length === 0) {
    return "inactive";
  }

  const statuses = proposals.map((proposal) => getProposalStatus(proposal));

  if (statuses.includes("active")) {
    return "active";
  }

  if (statuses.includes("scheduled")) {
    return "scheduled";
  }

  return "ended";
}

function getSessionKey(session) {
  return getSessionProposals(session)
    .map((proposal) => proposal.proposal_id)
    .join("|");
}

function findProposalById(session, proposalId) {
  return getSessionProposals(session).find((proposal) => proposal.proposal_id === proposalId) || null;
}

function getProposalStatus(proposal) {
  return getStatusForTimes(proposal.start_time, proposal.end_time);
}

function getStatusForTimes(startTime, endTime) {
  const now = Math.floor(Date.now() / 1000);

  if (now < startTime) {
    return "scheduled";
  }

  if (now >= endTime) {
    return "ended";
  }

  return "active";
}

function readVotesCsv(proposal) {
  const proposalCsvPath = getProposalCsvPath(proposal);

  if (!proposalCsvPath || !fs.existsSync(proposalCsvPath)) {
    return {
      rows: [],
      header: [],
      optionColumns: [],
    };
  }

  const allRecords = splitCsvRecords(fs.readFileSync(proposalCsvPath, "utf8"));
  const headerIndex = allRecords.findIndex((record) => record.startsWith("wallet,"));
  const rows = headerIndex === -1 ? [] : allRecords.slice(headerIndex).filter(Boolean);
  const header = rows.length > 0 ? parseCsvColumns(rows[0]) : [];
  const optionColumns = header.filter((column) => ![
    "wallet",
    "solnauta_nfts",
    "torrino_nfts",
    "voting_power",
    "timestamp",
    "signed_message",
    "signature",
  ].includes(column));

  return { rows, header, optionColumns };
}

function buildEmptyUsedMintsRegistry(session) {
  return Object.fromEntries(
    getSessionProposals(session).map((proposal) => [proposal.proposal_id, []])
  );
}

function normalizeUsedMintsRegistry(value, session) {
  const proposals = getSessionProposals(session);
  const proposalIds = proposals.map((proposal) => proposal.proposal_id);

  if (Array.isArray(value)) {
    if (proposalIds.length === 1) {
      return {
        [proposalIds[0]]: value.filter(isValidMint),
      };
    }

    return buildEmptyUsedMintsRegistry(session);
  }

  if (!value || typeof value !== "object") {
    return buildEmptyUsedMintsRegistry(session);
  }

  return Object.fromEntries(
    proposalIds.map((proposalId) => [
      proposalId,
      Array.isArray(value[proposalId]) ? value[proposalId].filter(isValidMint) : [],
    ])
  );
}

function parseVoteCsvLine(line, header) {
  const columns = parseCsvColumns(line);
  const row = {};

  for (let index = 0; index < header.length; index += 1) {
    row[header[index]] = columns[index] || "";
  }

  return row;
}

function parseCsvColumns(line) {
  const columns = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "\"") {
      if (insideQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }

      continue;
    }

    if (character === "," && !insideQuotes) {
      columns.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  columns.push(current);
  return columns;
}

function splitStoredNftValues(value) {
  return value
    ? value.split(/\r?\n|\|/).map((item) => item.trim()).filter(Boolean)
    : [];
}

function formatVotingPowerValue(value) {
  return Number(Number(value || 0).toFixed(9));
}

function formatDecimal(value) {
  return Number(value || 0).toFixed(9);
}

function getOptionColumns(proposal) {
  return proposal && Array.isArray(proposal.options) ? proposal.options : [];
}

function getVotesCsvHeader(proposal) {
  const columns = [
    "wallet",
    "solnauta_nfts",
    "torrino_nfts",
    ...getOptionColumns(proposal).map((option) => escapeCsvValue(option)),
    "voting_power",
    "timestamp",
    "signed_message",
    "signature",
  ];

  return `${columns.join(",")}\n`;
}

function getUsedNftState(session = readProposal()) {
  const proposals = getSessionProposals(session);
  const registry = readUsedMintsRegistry();
  const usedMintsByProposal = new Map();

  for (const proposal of proposals) {
    const proposalId = proposal.proposal_id;
    const proposalUsedMints = new Set(Array.isArray(registry[proposalId]) ? registry[proposalId].filter(isValidMint) : []);

    for (const mint of readUsedMintsFromCsv(proposal)) {
      proposalUsedMints.add(mint);
    }

    usedMintsByProposal.set(proposalId, proposalUsedMints);
  }

  return {
    usedMintsByProposal,
  };
}

function splitCsvRecords(csvText) {
  const normalizedText = String(csvText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < normalizedText.length; index += 1) {
    const character = normalizedText[index];

    if (character === "\"") {
      if (insideQuotes && normalizedText[index + 1] === "\"") {
        current += "\"\"";
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
        current += character;
      }

      continue;
    }

    if (character === "\n" && !insideQuotes) {
      records.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  if (current || normalizedText.endsWith("\n")) {
    records.push(current);
  }

  return records;
}

function configureVotingSyncTimers(session) {
  stopVotingSyncTimers();

  const proposals = getSessionProposals(session);
  const primaryProposal = proposals[0];

  if (!primaryProposal) {
    return;
  }

  voteSyncState.proposalId = getSessionKey(session);
  const nowMs = Date.now();
  const startMs = Number(primaryProposal.start_time) * 1000;
  const endMs = Number(primaryProposal.end_time) * 1000;
  console.log("[voting-sync] configure", {
    proposalId: primaryProposal.proposal_id,
    nowIso: new Date(nowMs).toISOString(),
    startIso: Number.isFinite(startMs) ? new Date(startMs).toISOString() : "invalid",
    endIso: Number.isFinite(endMs) ? new Date(endMs).toISOString() : "invalid",
    status: getSessionStatus(session),
  });

  voteSyncState.initialCommitTimeoutId = setTimeout(() => {
    console.log("[voting-sync] initial commit", { proposalId: primaryProposal.proposal_id });
    commitVotesCsvToGit(buildLifecycleCommitMessage("active", session), {
      session,
      allowStatuses: ["scheduled", "active", "ended"],
    }).catch((error) => {
      console.error("Errore commit Git iniziale", error);
    });
  }, 10 * 1000);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= nowMs) {
    console.log("[voting-sync] immediate final scheduling", { proposalId: primaryProposal.proposal_id });
    scheduleFinalVotingCommit(session);
    return;
  }

  if (startMs <= nowMs) {
    console.log("[voting-sync] start periodic immediately", { proposalId: primaryProposal.proposal_id });
    startPeriodicVotingSync(session);
  } else {
    voteSyncState.startTimeoutId = setTimeout(() => {
      console.log("[voting-sync] delayed periodic start", { proposalId: primaryProposal.proposal_id });
      startPeriodicVotingSync(session);
    }, startMs - nowMs);
  }

  voteSyncState.endTimeoutId = setTimeout(() => {
    console.log("[voting-sync] end timeout fired", { proposalId: primaryProposal.proposal_id });
    scheduleFinalVotingCommit(session);
  }, Math.max(endMs - nowMs, 0));
}

function startPeriodicVotingSync(session) {
  const primaryProposal = getSessionProposals(session)[0];
  const sessionKey = getSessionKey(session);

  if (!primaryProposal || voteSyncState.proposalId !== sessionKey) {
    console.log("[voting-sync] periodic skipped", {
      proposalId: primaryProposal ? primaryProposal.proposal_id : null,
      activeProposalId: voteSyncState.proposalId,
    });
    return;
  }

  if (getSessionStatus(session) !== "active") {
    console.log("[voting-sync] periodic not active", {
      proposalId: primaryProposal.proposal_id,
      status: getSessionStatus(session),
    });
    return;
  }

  console.log("[voting-sync] periodic started", { proposalId: primaryProposal.proposal_id });
  voteSyncState.intervalId = setInterval(() => {
    if (getSessionStatus(session) !== "active") {
      console.log("[voting-sync] periodic tick skipped", {
        proposalId: primaryProposal.proposal_id,
        status: getSessionStatus(session),
      });
      return;
    }

    console.log("[voting-sync] periodic tick commit", { proposalId: primaryProposal.proposal_id });
    commitVotesCsvToGit(buildLifecycleCommitMessage("active", session), {
      session,
      allowStatuses: ["active"],
    }).catch((error) => {
      console.error("Errore sync Git periodico", error);
    });
  }, GIT_UPDATE_INTERVAL_MS);
}

function scheduleFinalVotingCommit(session) {
  const primaryProposal = getSessionProposals(session)[0];
  const sessionKey = getSessionKey(session);

  if (!primaryProposal || voteSyncState.proposalId !== sessionKey) {
    console.log("[voting-sync] final skipped", {
      proposalId: primaryProposal ? primaryProposal.proposal_id : null,
      activeProposalId: voteSyncState.proposalId,
    });
    return;
  }

  console.log("[voting-sync] final commit start", {
    proposalId: primaryProposal.proposal_id,
    status: getSessionStatus(session),
  });
  stopVotingSyncTimers();
  commitVotesCsvToGit(buildLifecycleCommitMessage("completed", session), {
    session,
    allowStatuses: ["ended"],
  }).catch((error) => {
    console.error("Errore commit Git finale", error);
  });
}

function stopVotingSyncTimers() {
  if (voteSyncState.initialCommitTimeoutId) {
    clearTimeout(voteSyncState.initialCommitTimeoutId);
    voteSyncState.initialCommitTimeoutId = null;
  }

  if (voteSyncState.intervalId) {
    clearInterval(voteSyncState.intervalId);
    voteSyncState.intervalId = null;
  }

  if (voteSyncState.startTimeoutId) {
    clearTimeout(voteSyncState.startTimeoutId);
    voteSyncState.startTimeoutId = null;
  }

  if (voteSyncState.endTimeoutId) {
    clearTimeout(voteSyncState.endTimeoutId);
    voteSyncState.endTimeoutId = null;
  }

  voteSyncState.proposalId = null;
}

function restoreVotingSyncTimers() {
  const session = readProposal();
  const primaryProposal = getSessionProposals(session)[0];

  if (!primaryProposal) {
    console.log("[voting-sync] restore skipped: no proposal");
    return;
  }

  console.log("[voting-sync] restore", {
    proposalId: primaryProposal.proposal_id,
    status: getSessionStatus(session),
  });
  configureVotingSyncTimers(session);
}

async function commitVotesCsvToGit(message, options = {}) {
  const session = options.session || readProposal();
  const proposals = getSessionProposals(session);
  const proposalCsvPaths = proposals.map((proposal) => getProposalCsvPath(proposal)).filter(Boolean);
  const primaryProposal = proposals[0];

  if (!primaryProposal || proposalCsvPaths.length === 0 || proposalCsvPaths.some((filePath) => !fs.existsSync(filePath))) {
    console.log("[voting-sync] commit skipped: missing proposal or csv", {
      message,
      proposalId: primaryProposal ? primaryProposal.proposal_id : null,
      proposalCsvPath: proposalCsvPaths,
    });
    return;
  }

  const status = getSessionStatus(session);
  const allowStatuses = Array.isArray(options.allowStatuses) ? options.allowStatuses : ["active"];

  if (!allowStatuses.includes(status)) {
    console.log("[voting-sync] commit skipped: status not allowed", {
      message,
      proposalId: primaryProposal.proposal_id,
      status,
      allowStatuses,
    });
    return;
  }

  console.log("[voting-sync] commit start", {
    message,
    proposalId: primaryProposal.proposal_id,
    status,
  });
  if (!options.skipMetadataRewrite) {
    const lifecycleTimestamp = status === "ended"
      ? Number(primaryProposal.end_time) || Math.floor(Date.now() / 1000)
      : Math.floor(Date.now() / 1000);

    for (const proposal of proposals) {
      rewriteProposalMetadata(proposal, ADMIN_WALLET, { lifecycleTimestamp });
    }
  }

  await runGitCommand(["add", ...proposals.map((proposal) => getProposalCsvRelativePath(proposal)).filter(Boolean)]);

  try {
    await runGitCommand(["commit", "-m", message]);
  } catch (error) {
    const combinedOutput = `${error.stdout || ""}\n${error.stderr || ""}`;

    if (!combinedOutput.includes("nothing to commit")) {
      throw error;
    }

    console.log("[voting-sync] commit noop", {
      message,
      proposalId: primaryProposal.proposal_id,
    });
  }

  await runGitCommand(["push", "origin", "main"]);
  console.log("[voting-sync] commit pushed", {
    message,
    proposalId: primaryProposal.proposal_id,
  });
}

async function runGitCommand(args) {
  return execFileAsync("git", ["-C", APP_DIR, ...args], {
    cwd: APP_DIR,
  });
}

function readUsedMintsFromCsv(proposal) {
  const csvData = readVotesCsv(proposal);
  const usedMints = new Set();

  if (csvData.rows.length <= 1) {
    return usedMints;
  }

  for (let index = 1; index < csvData.rows.length; index += 1) {
    const row = parseVoteCsvLine(csvData.rows[index], csvData.header);

    for (const value of splitStoredNftValues(row.solnauta_nfts)) {
      const mint = extractMintFromStoredValue(value);

      if (mint) {
        usedMints.add(mint);
      }
    }

    for (const value of splitStoredNftValues(row.torrino_nfts)) {
      const mint = extractMintFromStoredValue(value);

      if (mint) {
        usedMints.add(mint);
      }
    }
  }

  return usedMints;
}

function findProposalByPayloadHash(proposalPayloadHash) {
  ensureDataDir();
  const fileNames = fs.readdirSync(DATA_DIR).filter((fileName) => fileName.endsWith(".csv"));

  for (const fileName of fileNames) {
    const filePath = path.join(DATA_DIR, fileName);
    const metadata = readProposalMetadataFromCsvFile(filePath);

    if (!metadata.proposal_payload_hash) {
      continue;
    }

    const proposal = {
      title: metadata.proposal_title || "",
      description: metadata.proposal_description || "",
      options: metadata.proposal_options
        ? metadata.proposal_options.split(" | ").map((item) => item.trim()).filter(Boolean)
        : [],
    };
    const recalculatedHash = hashProposalPayload(proposal);

    if (
      metadata.proposal_payload_hash.toLowerCase() === proposalPayloadHash &&
      recalculatedHash === proposalPayloadHash
    ) {
      return {
        csv_file_name: fileName,
        proposal,
      };
    }
  }

  return null;
}

function readProposalMetadataFromCsvFile(filePath) {
  const metadata = {};

  if (!filePath || !fs.existsSync(filePath)) {
    return metadata;
  }

  const records = splitCsvRecords(fs.readFileSync(filePath, "utf8"));

  for (const record of records) {
    if (!record || record.startsWith("wallet,")) {
      break;
    }

    const columns = parseCsvColumns(record);
    if (columns.length < 2) {
      continue;
    }

    const key = getString(columns[0]);
    const value = columns.slice(1).join(",");

    if (key) {
      metadata[key] = value;
    }
  }

  return metadata;
}

function extractMintFromStoredValue(value) {
  const normalizedValue = getString(value);

  if (!normalizedValue) {
    return "";
  }

  const solscanMatch = normalizedValue.match(/^https?:\/\/solscan\.io\/token\/([1-9A-HJ-NP-Za-km-z]+)$/);

  if (solscanMatch) {
    return solscanMatch[1];
  }

  return isValidMint(normalizedValue) ? normalizedValue : "";
}

function getProposalLifecycleMetadata(proposal, adminWallet, metadataOptions = {}) {
  const resetTimestamp = Number.isFinite(metadataOptions.resetTimestamp)
    ? Math.floor(metadataOptions.resetTimestamp)
    : 0;
  const lifecycleTimestamp = Number.isFinite(metadataOptions.lifecycleTimestamp)
    ? Math.floor(metadataOptions.lifecycleTimestamp)
    : Math.floor(Date.now() / 1000);

  if (resetTimestamp > 0) {
    return {
      status: `Voting stopped by admin ${adminWallet}`,
      timestamp: resetTimestamp,
    };
  }

  if (getProposalStatus(proposal) === "ended") {
    return {
      status: "Voting completed successfully",
      timestamp: lifecycleTimestamp,
    };
  }

  if (getProposalStatus(proposal) === "active") {
    return {
      status: "Voting in progress",
      timestamp: lifecycleTimestamp,
    };
  }

  return {
    status: "Scheduled",
    timestamp: lifecycleTimestamp,
  };
}

function buildLifecycleCommitMessage(statusKey, session, adminWallet = "") {
  const proposalLabels = getSessionProposals(session)
    .map((proposal) => getProposalCsvFileName(proposal))
    .filter(Boolean);

  if (proposalLabels.length === 0) {
    return "voting status update";
  }

  const proposalLabel = proposalLabels.join(" ");

  if (statusKey === "stopped") {
    return `voting stopped by admin ${adminWallet} ${proposalLabel}`;
  }

  if (statusKey === "completed") {
    return `voting completed successfully ${proposalLabel}`;
  }

  return `voting in progress ${proposalLabel}`;
}

function getProposalParticipationMetadata(proposal) {
  const proposalCsvPath = getProposalCsvPath(proposal);

  if (!proposal || !proposalCsvPath || !fs.existsSync(proposalCsvPath)) {
    return {
      torrinoParticipationRate: "0.0%",
      solnautaParticipationRate: "0.0%",
      totalVotingPowerParticipationRate: "0.0%",
    };
  }

  const results = calculateProposalResults(proposal);

  return {
    torrinoParticipationRate: formatParticipationRate(results.torrino_voted, TORRINO_TOTAL_NFTS),
    solnautaParticipationRate: formatParticipationRate(results.solnauta_voted, SOLNAUTA_TOTAL_NFTS),
    totalVotingPowerParticipationRate: formatParticipationRate(results.total_power, TOTAL_VOTING_POWER),
  };
}

function formatParticipationRate(value, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return "0.0%";
  }

  return `${((Number(value || 0) / total) * 100).toFixed(1)}%`;
}

function normalizeProposalResultLabel(value) {
  const normalized = getString(value)
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "");

  return normalized || "option";
}

function buildProposalPayloadForHash(proposal) {
  return {
    title: getString(proposal && proposal.title),
    description: getString(proposal && proposal.description),
    options: Array.isArray(proposal && proposal.options)
      ? proposal.options.map(getString).filter(Boolean)
      : [],
  };
}

function hashProposalPayload(proposal) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(buildProposalPayloadForHash(proposal)))
    .digest("hex");
}

function normalizeProposalName(value) {
  const normalized = getString(value)
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, PROPOSAL_NAME_MAX_LENGTH);

  return normalized;
}

function getProposalCreatedDateKey(proposal) {
  const createdTimestamp = Number(proposal && proposal.proposal_id);
  const createdDate = Number.isFinite(createdTimestamp) && createdTimestamp > 0
    ? new Date(createdTimestamp * 1000)
    : new Date();
  const year = createdDate.getUTCFullYear();
  const month = String(createdDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(createdDate.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getProposalDisplayName(proposal) {
  const proposalName = normalizeProposalName(proposal && proposal.proposal_name);
  return proposalName || getString(proposal && proposal.proposal_id) || "proposal";
}

function getProposalCsvBaseName(proposal) {
  const proposalName = getProposalDisplayName(proposal);
  return `${proposalName}_${getProposalCreatedDateKey(proposal)}`;
}

function getProposalCsvFileName(proposal) {
  const baseName = getProposalCsvBaseName(proposal);
  return baseName ? `${baseName}.csv` : "";
}

function getProposalCsvPath(proposal) {
  if (!proposal || !proposal.proposal_id) {
    return null;
  }

  if (!normalizeProposalName(proposal.proposal_name)) {
    return path.join(DATA_DIR, `proposal_${proposal.proposal_id}.csv`);
  }

  const baseName = getProposalCsvBaseName(proposal);
  return path.join(DATA_DIR, `${baseName}.csv`);
}

function getProposalCsvRelativePath(proposal) {
  if (!proposal || !proposal.proposal_id) {
    return null;
  }

  if (!normalizeProposalName(proposal.proposal_name)) {
    return `data/proposal_${proposal.proposal_id}.csv`;
  }

  const baseName = getProposalCsvBaseName(proposal);
  return `data/${baseName}.csv`;
}

function assertProposalFileNamesAvailable(session) {
  const seenNames = new Set();

  for (const proposal of getSessionProposals(session)) {
    const relativePath = getProposalCsvRelativePath(proposal);

    if (!relativePath || seenNames.has(relativePath)) {
      const error = new Error("PROPOSAL_FILE_CONFLICT");
      error.code = "PROPOSAL_FILE_CONFLICT";
      throw error;
    }

    seenNames.add(relativePath);

    const absolutePath = getProposalCsvPath(proposal);
    if (absolutePath && fs.existsSync(absolutePath)) {
      const error = new Error("PROPOSAL_FILE_CONFLICT");
      error.code = "PROPOSAL_FILE_CONFLICT";
      throw error;
    }
  }
}

function deleteFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeFileAtomic(filePath, fileContents) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, fileContents, "utf8");
  fs.renameSync(tempPath, filePath);
}

function withMutationLock(task) {
  const nextTask = mutationQueue.then(() => task());
  mutationQueue = nextTask.catch(() => {});
  return nextTask;
}

function formatTimestampIso(timestamp) {
  const numericTimestamp = Number(timestamp);

  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
    return "";
  }

  return new Date(numericTimestamp * 1000).toISOString();
}

function escapeCsvValue(value) {
  const stringValue = String(value);

  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replace(/"/g, "\"\"")}"`;
}

function getString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = "";
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > JSON_BODY_MAX_BYTES) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }

      rawBody += chunk;
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function serveStaticFile(requestPath, res, headOnly) {
  const normalizedPath = requestPath === "/"
    ? "/index.html"
    : requestPath === "/admin"
      ? "/admin.html"
      : requestPath === "/vote.verifier"
        ? "/vote.verifier.html"
      : requestPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${path.normalize(normalizedPath)}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  const pathSegments = relativePath.split(path.sep).filter(Boolean);
  const fileExtension = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  if (
    !filePath.startsWith(PUBLIC_DIR) ||
    relativePath.startsWith("..") ||
    pathSegments.some((segment) => segment.startsWith(".")) ||
    pathSegments.some((segment) => BLOCKED_STATIC_PATH_SEGMENTS.has(segment)) ||
    basename.startsWith(".") ||
    BLOCKED_STATIC_BASENAMES.has(basename) ||
    !STATIC_ALLOWED_EXTENSIONS.has(fileExtension)
  ) {
    sendJson(res, 403, { error: "FORBIDDEN" });
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: "SERVER_ERROR" });
      return;
    }

    const contentType = MIME_TYPES[fileExtension] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });

    if (headOnly) {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
}

function isRateLimited(req, pathname) {
  if (!["/api/wallet-nfts", "/api/vote", "/api/admin/challenge", "/api/admin/proposal", "/api/admin/reset-voting", "/api/verify-vote-record", "/api/verify-proposal-hash"].includes(pathname)) {
    return false;
  }

  const clientIp = getClientIp(req);
  const now = Date.now();
  cleanupRateLimitStore(now);
  const entry = rateLimitStore.get(clientIp) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count += 1;
  rateLimitStore.set(clientIp, entry);

  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

function cleanupRateLimitStore(now = Date.now()) {
  for (const [clientIp, entry] of rateLimitStore.entries()) {
    if (!entry || entry.resetAt <= now) {
      rateLimitStore.delete(clientIp);
    }
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
