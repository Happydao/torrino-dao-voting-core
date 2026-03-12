const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { URL } = require("url");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const RPC = process.env.HELIUS_RPC;
const ADMIN_WALLET = process.env.ADMIN_WALLET || "5feimx18jM2hK2rvZnQHRsjhSeCkHAiLeQZDuJkU2fPc";
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const VOTES_CSV_PATH = path.join(DATA_DIR, "votes.csv");
const USED_MINTS_PATH = path.join(DATA_DIR, "used-mints.json");
const PROPOSAL_PATH = path.join(DATA_DIR, "proposal.json");
const GIT_UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const COLLECTIONS = {
  torrino: {
    name: "Torrino DAO",
    address: "DKaSqu5ftJTkxr9yGyxCakooFZAi2X5aa6SGhs5yR81t",
    weight: 0.9,
  },
  solnauta: {
    name: "Solnauta",
    address: "FSKamMRcYWVWxuCzKLofdVSDgwkZ1ufEy99Q9ig3SfG4",
    weight: 0.1,
  },
};
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const execFileAsync = promisify(execFile);
const voteSyncState = {
  intervalId: null,
  startTimeoutId: null,
  endTimeoutId: null,
  proposalId: null,
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    serveStaticFile(requestUrl.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
});

server.listen(PORT, () => {
  console.log(`Server in ascolto su http://localhost:${PORT}`);
  configureVotingSyncTimers(readProposal());
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
    const assets = await getAllAssetsByOwner(walletAddress);
    sendJson(res, 200, summarizeWalletAssets(assets, getUsedNftState()));
  } catch (error) {
    console.error(error);
    sendJson(res, 502, { error: "SERVER_ERROR" });
  }
}

function handleProposal(res) {
  const proposal = readProposal();

  if (!proposal) {
    sendJson(res, 200, { proposal: null, status: "inactive", is_voting_open: false });
    return;
  }

  const status = getProposalStatus(proposal);
  sendJson(res, 200, {
    ...proposal,
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

  const proposal = readProposal();
  const proposalStatus = proposal ? getProposalStatus(proposal) : "inactive";

  if (!proposal || proposalStatus === "inactive" || proposalStatus === "ended") {
    sendJson(res, 403, { error: "VOTING_ENDED" });
    return;
  }

  if (proposalStatus === "scheduled") {
    sendJson(res, 403, { error: "VOTING_NOT_STARTED" });
    return;
  }

  const body = await readJsonBody(req);
  const wallet = getString(body.wallet);
  const vote = getString(body.vote);
  const signature = getString(body.signature) || "not-signed";

  if (!wallet || !vote || !proposal.options.includes(vote)) {
    sendJson(res, 400, { error: "SERVER_ERROR" });
    return;
  }

  try {
    ensureVoteStorageFiles();
    const assets = await getAllAssetsByOwner(wallet);
    const summary = summarizeWalletAssets(assets, getUsedNftState());
    const usableGen1Nfts = summary.gen1_nfts.filter((nft) => nft.status === "AVAILABLE");
    const usableGen2Nfts = summary.gen2_nfts.filter((nft) => nft.status === "AVAILABLE");
    const usableNfts = [...usableGen2Nfts, ...usableGen1Nfts];

    if (usableNfts.length === 0) {
      sendJson(res, 409, {
        error: "ALL_NFTS_ALREADY_VOTED",
        message: "All NFTs from this wallet have already voted.",
      });
      return;
    }

    appendVoteRow({
      wallet,
      solnautaNfts: usableGen2Nfts.map((nft) => nft.name),
      torrinoNfts: usableGen1Nfts.map((nft) => nft.name),
      vote,
      votingPower: Number(
        (
          usableGen1Nfts.length * COLLECTIONS.torrino.weight +
          usableGen2Nfts.length * COLLECTIONS.solnauta.weight
        ).toFixed(1)
      ),
      timestamp: Math.floor(Date.now() / 1000),
      signature,
    });
    registerUsedMints(usableNfts.map((nft) => nft.mint));

    sendJson(res, 200, {
      success: true,
      voting_power: Number(
        (
          usableGen1Nfts.length * COLLECTIONS.torrino.weight +
          usableGen2Nfts.length * COLLECTIONS.solnauta.weight
        ).toFixed(1)
      ),
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

  if (getString(body.admin_wallet) !== ADMIN_WALLET) {
    sendJson(res, 403, { error: "UNAUTHORIZED_ADMIN" });
    return;
  }

  const title = getString(body.title);
  const description = getString(body.description);
  const options = Array.isArray(body.options)
    ? body.options.map(getString).filter(Boolean).slice(0, 5)
    : [];
  const startTime = Number(body.start_time);
  const endTime = Number(body.end_time);

  if (!title || !description || options.length === 0) {
    sendJson(res, 400, { error: "INVALID_PROPOSAL" });
    return;
  }

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    sendJson(res, 400, { error: "INVALID_TIME_RANGE" });
    return;
  }

  const proposal = {
    proposal_id: `proposal_${Date.now()}`,
    title,
    description,
    options,
    start_time: Math.floor(startTime),
    end_time: Math.floor(endTime),
    status: getStatusForTimes(startTime, endTime),
  };

  try {
    ensureDataDir();
    fs.writeFileSync(PROPOSAL_PATH, JSON.stringify(proposal, null, 2) + "\n", "utf8");
    initializeVoteStorageForProposal(proposal, ADMIN_WALLET);
    configureVotingSyncTimers(proposal);
    sendJson(res, 200, { success: true, proposal });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
}

async function handleAdminReset(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "SERVER_ERROR" });
    return;
  }

  const body = await readJsonBody(req);

  if (getString(body.admin_wallet) !== ADMIN_WALLET) {
    sendJson(res, 403, { error: "UNAUTHORIZED_ADMIN" });
    return;
  }

  try {
    deleteFileIfExists(VOTES_CSV_PATH);
    deleteFileIfExists(USED_MINTS_PATH);
    if (fs.existsSync(PROPOSAL_PATH)) {
      fs.unlinkSync(PROPOSAL_PATH);
    }

    stopVotingSyncTimers();

    sendJson(res, 200, { success: true });
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

function summarizeWalletAssets(assets, usedState) {
  const gen1Names = [];
  const gen2Names = [];
  const gen1Mints = [];
  const gen2Mints = [];
  const gen1Nfts = [];
  const gen2Nfts = [];
  const usedMints = usedState ? usedState.usedMints : new Set();
  const votedNames = usedState ? usedState.votedNames : new Set();

  for (const asset of assets) {
    const assetName = getAssetName(asset);
    const assetMint = getAssetMint(asset);
    const assetStatus = usedMints.has(assetMint) || votedNames.has(assetName) ? "USED" : "AVAILABLE";

    if (assetBelongsToCollection(asset, COLLECTIONS.torrino.address)) {
      gen1Names.push(assetName);
      gen1Mints.push(assetMint);
      gen1Nfts.push({ mint: assetMint, name: assetName, status: assetStatus });
    } else if (assetBelongsToCollection(asset, COLLECTIONS.solnauta.address)) {
      gen2Names.push(assetName);
      gen2Mints.push(assetMint);
      gen2Nfts.push({ mint: assetMint, name: assetName, status: assetStatus });
    }
  }

  const gen1Count = gen1Nfts.length;
  const gen2Count = gen2Nfts.length;
  const availableGen1Count = gen1Nfts.filter((nft) => nft.status === "AVAILABLE").length;
  const availableGen2Count = gen2Nfts.filter((nft) => nft.status === "AVAILABLE").length;
  const votingPower = Number(
    (availableGen1Count * COLLECTIONS.torrino.weight + availableGen2Count * COLLECTIONS.solnauta.weight).toFixed(1)
  );

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
  };
}

function calculateResults() {
  const proposal = readProposal();
  const baseResults = {
    proposal_id: proposal ? proposal.proposal_id : null,
    status: proposal ? getProposalStatus(proposal) : "inactive",
    solnauta_voted: 0,
    torrino_voted: 0,
    total_power: 0,
    option_results: proposal
      ? proposal.options.map((option) => ({ option, power: 0, percent: 0 }))
      : [],
  };

  if (!proposal || !fs.existsSync(VOTES_CSV_PATH)) {
    return baseResults;
  }

  const csvData = readVotesCsv();
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

    solnautaVoted += splitPipeList(row.solnauta_nfts).length;
    torrinoVoted += splitPipeList(row.torrino_nfts).length;
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

  return typeof name === "string" && name.trim() ? name.trim() : "NFT senza nome";
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
  const proposal = readProposal();
  const header = getVotesCsvHeader(proposal);

  if (createFreshFiles) {
    fs.writeFileSync(VOTES_CSV_PATH, header, "utf8");
    fs.writeFileSync(USED_MINTS_PATH, "[]\n", "utf8");
    return;
  }

  if (!fs.existsSync(VOTES_CSV_PATH)) {
    fs.writeFileSync(VOTES_CSV_PATH, header, "utf8");
  }

  if (!fs.existsSync(USED_MINTS_PATH)) {
    fs.writeFileSync(USED_MINTS_PATH, "[]\n", "utf8");
  }
}

function initializeVoteStorageForProposal(proposal, adminWallet) {
  ensureDataDir();
  const auditLines = [
    `proposal_created_by,${escapeCsvValue(adminWallet)}`,
    `proposal_created_timestamp,${Math.floor(Date.now() / 1000)}`,
    `proposal_title,${escapeCsvValue(proposal.title)}`,
    `proposal_question,${escapeCsvValue(proposal.description)}`,
    `options,${escapeCsvValue(proposal.options.join("|"))}`,
    "",
    getVotesCsvHeader(proposal).trimEnd(),
  ];

  fs.writeFileSync(VOTES_CSV_PATH, `${auditLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(USED_MINTS_PATH, "[]\n", "utf8");
}

function ensureVoteStorageFiles() {
  ensureDataDir();

  if (!fs.existsSync(USED_MINTS_PATH)) {
    fs.writeFileSync(USED_MINTS_PATH, "[]\n", "utf8");
  }

  if (!fs.existsSync(VOTES_CSV_PATH)) {
    const proposal = readProposal();

    if (proposal) {
      initializeVoteStorageForProposal(proposal, ADMIN_WALLET);
    } else {
      fs.writeFileSync(VOTES_CSV_PATH, `${getVotesCsvHeader(null)}`, "utf8");
    }
  }
}

function appendVoteRow(row) {
  const proposal = readProposal();
  const optionValues = getOptionColumns(proposal).map((optionLabel) => {
    return escapeCsvValue(formatDecimal(optionLabel === row.vote ? row.votingPower : 0));
  });
  const csvLine = [
    escapeCsvValue(row.wallet),
    escapeCsvValue(row.solnautaNfts.join("|")),
    escapeCsvValue(row.torrinoNfts.join("|")),
    ...optionValues,
    escapeCsvValue(formatDecimal(row.votingPower)),
    escapeCsvValue(String(row.timestamp)),
    escapeCsvValue(row.signature),
  ].join(",") + "\n";

  fs.appendFileSync(VOTES_CSV_PATH, csvLine, "utf8");
}

function readUsedMintsRegistry() {
  if (!fs.existsSync(USED_MINTS_PATH)) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(USED_MINTS_PATH, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed.filter(isValidMint) : []);
  } catch (error) {
    console.error("Impossibile leggere used-mints.json", error);
    return new Set();
  }
}

function registerUsedMints(mints) {
  const currentMints = readUsedMintsRegistry();

  for (const mint of mints) {
    if (isValidMint(mint)) {
      currentMints.add(mint);
    }
  }

  fs.writeFileSync(USED_MINTS_PATH, JSON.stringify(Array.from(currentMints).sort(), null, 2) + "\n", "utf8");
}

function isValidMint(value) {
  return typeof value === "string" && value.trim() && value !== "unknown-mint";
}

function readProposal() {
  if (!fs.existsSync(PROPOSAL_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(PROPOSAL_PATH, "utf8"));
  } catch (error) {
    console.error("Impossibile leggere proposal.json", error);
    return null;
  }
}

function getProposalStatus(proposal) {
  return getStatusForTimes(proposal.start_time, proposal.end_time);
}

function getStatusForTimes(startTime, endTime) {
  const now = Math.floor(Date.now() / 1000);

  if (now < startTime) {
    return "scheduled";
  }

  if (now > endTime) {
    return "ended";
  }

  return "active";
}

function parseVoteCsvLine(line) {
  const columns = parseCsvColumns(line);
  return {
    wallet: columns[0] || "",
    solnauta_nfts: columns[1] || "",
    torrino_nfts: columns[2] || "",
    vote: columns[3] || "",
    voting_power: columns[4] || "0",
    timestamp: columns[5] || "",
    signature: columns[6] || "",
  };
}

function readVotesCsv() {
  if (!fs.existsSync(VOTES_CSV_PATH)) {
    return {
      rows: [],
      header: [],
      optionColumns: [],
    };
  }

  const allLines = fs.readFileSync(VOTES_CSV_PATH, "utf8").split(/\r?\n/);
  const headerIndex = allLines.findIndex((line) => line.startsWith("wallet,"));
  const rows = headerIndex === -1 ? [] : allLines.slice(headerIndex).filter(Boolean);
  const header = rows.length > 0 ? parseCsvColumns(rows[0]) : [];
  const optionColumns = header.filter((column) => ![
    "wallet",
    "solnauta_nfts",
    "torrino_nfts",
    "voting_power",
    "timestamp",
    "signature",
  ].includes(column));

  return { rows, header, optionColumns };
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

function splitPipeList(value) {
  return value ? value.split("|").map((item) => item.trim()).filter(Boolean) : [];
}

function formatDecimal(value) {
  return Number(value || 0).toFixed(1);
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
    "signature",
  ];

  return `${columns.join(",")}\n`;
}

function getUsedNftState() {
  return {
    usedMints: readUsedMintsRegistry(),
    votedNames: readVotedNftNamesFromCsv(),
  };
}

function configureVotingSyncTimers(proposal) {
  stopVotingSyncTimers();

  if (!proposal) {
    return;
  }

  voteSyncState.proposalId = proposal.proposal_id;
  const nowMs = Date.now();
  const startMs = Number(proposal.start_time) * 1000;
  const endMs = Number(proposal.end_time) * 1000;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= nowMs) {
    scheduleFinalVotingCommit(proposal);
    return;
  }

  if (startMs <= nowMs) {
    startPeriodicVotingSync(proposal);
  } else {
    voteSyncState.startTimeoutId = setTimeout(() => {
      startPeriodicVotingSync(proposal);
    }, startMs - nowMs);
  }

  voteSyncState.endTimeoutId = setTimeout(() => {
    scheduleFinalVotingCommit(proposal);
  }, Math.max(endMs - nowMs, 0));
}

function startPeriodicVotingSync(proposal) {
  if (!proposal || voteSyncState.proposalId !== proposal.proposal_id) {
    return;
  }

  if (getProposalStatus(proposal) !== "active") {
    return;
  }

  voteSyncState.intervalId = setInterval(() => {
    if (getProposalStatus(proposal) !== "active") {
      return;
    }

    commitVotesCsvToGit(`voting update ${Math.floor(Date.now() / 1000)}`).catch((error) => {
      console.error("Errore sync Git periodico", error);
    });
  }, GIT_UPDATE_INTERVAL_MS);
}

function scheduleFinalVotingCommit(proposal) {
  if (!proposal || voteSyncState.proposalId !== proposal.proposal_id) {
    return;
  }

  stopVotingSyncTimers();
  commitVotesCsvToGit(`final voting results ${Math.floor(Date.now() / 1000)}`).catch((error) => {
    console.error("Errore commit Git finale", error);
  });
}

function stopVotingSyncTimers() {
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

async function commitVotesCsvToGit(message) {
  if (!fs.existsSync(VOTES_CSV_PATH)) {
    return;
  }

  const proposal = readProposal();

  if (!proposal) {
    return;
  }

  const status = getProposalStatus(proposal);
  const isFinalCommit = message.startsWith("final voting results");

  if (!isFinalCommit && status !== "active") {
    return;
  }

  await runGitCommand(["add", "data/votes.csv"]);

  try {
    await runGitCommand(["commit", "-m", message]);
  } catch (error) {
    const combinedOutput = `${error.stdout || ""}\n${error.stderr || ""}`;

    if (!combinedOutput.includes("nothing to commit")) {
      throw error;
    }
  }

  await runGitCommand(["push", "origin", "main"]);
}

async function runGitCommand(args) {
  return execFileAsync("git", ["-C", PUBLIC_DIR, ...args], {
    cwd: PUBLIC_DIR,
  });
}

function readVotedNftNamesFromCsv() {
  const csvData = readVotesCsv();
  const votedNames = new Set();

  if (csvData.rows.length <= 1) {
    return votedNames;
  }

  for (let index = 1; index < csvData.rows.length; index += 1) {
    const row = parseVoteCsvLine(csvData.rows[index], csvData.header);

    for (const name of splitPipeList(row.solnauta_nfts)) {
      votedNames.add(name);
    }

    for (const name of splitPipeList(row.torrino_nfts)) {
      votedNames.add(name);
    }
  }

  return votedNames;
}

function deleteFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
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

    req.on("data", (chunk) => {
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
      : requestPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(normalizedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "SERVER_ERROR" });
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: "SERVER_ERROR" });
      return;
    }

    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });

    if (headOnly) {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
