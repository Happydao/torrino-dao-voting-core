const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const RPC = process.env.HELIUS_RPC;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const VOTES_CSV_PATH = path.join(DATA_DIR, "votes.csv");
const USED_MINTS_PATH = path.join(DATA_DIR, "used-mints.json");
const VOTES_CSV_HEADER = "wallet,solnauta_nfts,torrino_nfts,vote,yes_power,no_power,timestamp,signature\n";
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

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/wallet-nfts") {
      await handleWalletNfts(requestUrl, res);
      return;
    }

    if (requestUrl.pathname === "/api/vote") {
      await handleVote(req, res);
      return;
    }

    if (requestUrl.pathname === "/api/results") {
      handleResults(res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Metodo non supportato." });
      return;
    }

    serveStaticFile(requestUrl.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Errore interno del server." });
  }
});

server.listen(PORT, () => {
  console.log(`Server in ascolto su http://localhost:${PORT}`);
});

async function handleWalletNfts(requestUrl, res) {
  if (!RPC) {
    sendJson(res, 500, { error: "Variabile HELIUS_RPC non configurata sul backend." });
    return;
  }

  const walletAddress = requestUrl.searchParams.get("address");

  if (!walletAddress) {
    sendJson(res, 400, { error: "Parametro address mancante." });
    return;
  }

  try {
    const assets = await getAllAssetsByOwner(walletAddress);
    const summary = summarizeWalletAssets(assets);
    sendJson(res, 200, summary);
  } catch (error) {
    console.error(error);
    sendJson(res, 502, {
      error: "Impossibile leggere gli NFT dal provider RPC configurato.",
    });
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

  const body = await readJsonBody(req);
  const wallet = body && typeof body.wallet === "string" ? body.wallet.trim() : "";
  const vote = body && typeof body.vote === "string" ? body.vote.trim().toLowerCase() : "";
  const signature = body && typeof body.signature === "string" ? body.signature.trim() : "";

  if (!wallet || (vote !== "yes" && vote !== "no")) {
    sendJson(res, 400, { error: "SERVER_ERROR" });
    return;
  }

  try {
    ensureVotesCsv();
    const assets = await getAllAssetsByOwner(wallet);
    const summary = summarizeWalletAssets(assets);
    const usedMints = readUsedMintsRegistry();
    const allMints = [...summary.gen2_mints, ...summary.gen1_mints];
    const hasAlreadyVotedMint = allMints.some((mint) => usedMints.has(mint));

    if (hasAlreadyVotedMint) {
      sendJson(res, 409, { error: "NFT_ALREADY_VOTED" });
      return;
    }

    appendVoteRow({
      wallet,
      solnautaNfts: summary.gen2_names,
      torrinoNfts: summary.gen1_names,
      vote,
      yesPower: vote === "yes" ? summary.voting_power : 0,
      noPower: vote === "no" ? summary.voting_power : 0,
      timestamp: Math.floor(Date.now() / 1000),
      signature: signature || "not-signed",
    });
    registerUsedMints(allMints);

    sendJson(res, 200, {
      success: true,
      voting_power: summary.voting_power,
      gen1_count: summary.gen1_count,
      gen2_count: summary.gen2_count,
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "SERVER_ERROR" });
  }
}

function handleResults(res) {
  try {
    ensureVotesCsv();
    sendJson(res, 200, calculateResults());
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

    const pageItems = Array.isArray(data.result && data.result.items)
      ? data.result.items
      : [];

    items.push(...pageItems);

    if (pageItems.length < limit) {
      break;
    }

    page += 1;
  }

  return items;
}

function summarizeWalletAssets(assets) {
  const gen1Names = [];
  const gen2Names = [];
  const gen1Mints = [];
  const gen2Mints = [];

  for (const asset of assets) {
    const assetName = getAssetName(asset);
    const assetMint = getAssetMint(asset);

    if (assetBelongsToCollection(asset, COLLECTIONS.torrino.address)) {
      gen1Names.push(assetName);
      gen1Mints.push(assetMint);
    } else if (assetBelongsToCollection(asset, COLLECTIONS.solnauta.address)) {
      gen2Names.push(assetName);
      gen2Mints.push(assetMint);
    }
  }

  const gen1Count = gen1Names.length;
  const gen2Count = gen2Names.length;
  const votingPower = Number(
    (gen1Count * COLLECTIONS.torrino.weight + gen2Count * COLLECTIONS.solnauta.weight).toFixed(1)
  );

  return {
    gen1_count: gen1Count,
    gen2_count: gen2Count,
    gen1_names: gen1Names,
    gen2_names: gen2Names,
    gen1_mints: gen1Mints,
    gen2_mints: gen2Mints,
    voting_power: votingPower,
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

  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }

  return "NFT senza nome";
}

function getAssetMint(asset) {
  if (asset && typeof asset.id === "string" && asset.id.trim()) {
    return asset.id.trim();
  }

  return "unknown-mint";
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
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

function ensureVotesCsv() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(VOTES_CSV_PATH)) {
    fs.writeFileSync(VOTES_CSV_PATH, VOTES_CSV_HEADER, "utf8");
  }

  if (!fs.existsSync(USED_MINTS_PATH)) {
    fs.writeFileSync(USED_MINTS_PATH, "[]\n", "utf8");
  }
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

function appendVoteRow(row) {
  const csvLine = [
    escapeCsvValue(row.wallet),
    escapeCsvValue(row.solnautaNfts.join("|")),
    escapeCsvValue(row.torrinoNfts.join("|")),
    escapeCsvValue(row.vote),
    escapeCsvValue(formatDecimal(row.yesPower)),
    escapeCsvValue(formatDecimal(row.noPower)),
    escapeCsvValue(String(row.timestamp)),
    escapeCsvValue(row.signature),
  ].join(",") + "\n";

  fs.appendFileSync(VOTES_CSV_PATH, csvLine, "utf8");
}

function calculateResults() {
  if (!fs.existsSync(VOTES_CSV_PATH)) {
    return createEmptyResults();
  }

  const lines = fs.readFileSync(VOTES_CSV_PATH, "utf8").split(/\r?\n/).filter(Boolean);

  if (lines.length <= 1) {
    return createEmptyResults();
  }

  let solnautaVoted = 0;
  let torrinoVoted = 0;
  let yesPower = 0;
  let noPower = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const row = parseVoteCsvLine(lines[index]);
    solnautaVoted += splitPipeList(row.solnauta_nfts).length;
    torrinoVoted += splitPipeList(row.torrino_nfts).length;
    yesPower += Number.parseFloat(row.yes_power || "0") || 0;
    noPower += Number.parseFloat(row.no_power || "0") || 0;
  }

  const totalPower = yesPower + noPower;
  const yesPercent = totalPower > 0 ? Math.round((yesPower / totalPower) * 100) : 0;
  const noPercent = totalPower > 0 ? 100 - yesPercent : 0;

  return {
    solnauta_voted: solnautaVoted,
    torrino_voted: torrinoVoted,
    yes_power: Number(formatDecimal(yesPower)),
    no_power: Number(formatDecimal(noPower)),
    yes_percent: yesPercent,
    no_percent: noPercent,
  };
}

function createEmptyResults() {
  return {
    solnauta_voted: 0,
    torrino_voted: 0,
    yes_power: 0,
    no_power: 0,
    yes_percent: 0,
    no_percent: 0,
  };
}

function registerUsedMints(mints) {
  const currentMints = readUsedMintsRegistry();

  for (const mint of mints) {
    if (isValidMint(mint)) {
      currentMints.add(mint);
    }
  }

  fs.writeFileSync(
    USED_MINTS_PATH,
    JSON.stringify(Array.from(currentMints).sort(), null, 2) + "\n",
    "utf8"
  );
}

function isValidMint(value) {
  return typeof value === "string" && value.trim() && value !== "unknown-mint";
}

function parseVoteCsvLine(line) {
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

  return {
    wallet: columns[0] || "",
    solnauta_nfts: columns[1] || "",
    torrino_nfts: columns[2] || "",
    vote: columns[3] || "",
    yes_power: columns[4] || "0",
    no_power: columns[5] || "0",
    timestamp: columns[6] || "",
    signature: columns[7] || "",
  };
}

function splitPipeList(value) {
  if (!value) {
    return [];
  }

  return value.split("|").map((item) => item.trim()).filter(Boolean);
}

function formatDecimal(value) {
  return Number(value || 0).toFixed(1);
}

function escapeCsvValue(value) {
  const stringValue = String(value);

  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replace(/"/g, "\"\"")}"`;
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
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(normalizedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Accesso negato." });
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: "Risorsa non trovata." });
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
