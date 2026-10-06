// Proves at the instruction level that each ratio variant build differs from the audited
// TokenSwap build only in the SWAP_RATIO constant and the code offsets and lengths that move with it.
//
// Usage (after `npx hardhat compile`):
//   node scripts/prove-ratio-variants.js [--onchain <rpcUrl>] [--forge-out <dir>] [--json <file>]
//
// --forge-out compares each Foundry artifact (after `forge build`) with the Hardhat artifact, init code and
// runtime, after stripping metadata.
// --onchain compares the audited runtime with the deployed Polygon converter through eth_getCode.
// Without it the script does not access the network.
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const { splitCreationCode, compareVariant, compareRuntimeWithOnchain } = require("./lib/bytecode-diff");

const ROOT = path.join(__dirname, "..");
const ARTIFACTS = path.join(ROOT, "artifacts", "contracts");
const AUDITED = { source: "contracts/TokenSwap.sol", ratio: 1000 };
const VARIANTS = [750, 500, 250].map((ratio) => ({ source: `contracts/ratio-${ratio}/TokenSwap.sol`, ratio }));
const ONCHAIN_ADDRESS = "0x333068d06563a8dfdbf330a0e04a9d128e98bf5a";
const EXPECTED_SOLC = "0.8.12+commit.f00d7308";
const OZ_PREFIX = "@openzeppelin/contracts/";
// SWAP_RATIO is pushed at two runtime sites and never in the init code. The runtime part of the
// creation code is byte-identical to the deployed runtime (enforced by splitCreationCode), so the
// runtime count also covers the runtime embedded in the creation code.
const EXPECTED_RATIO_SITES = { runtime: 2, init: 0 };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Loads the artifact and its build-info for a source path such as contracts/ratio-750/TokenSwap.sol.
function loadBuild(source) {
  const dir = path.join(ARTIFACTS, path.relative("contracts", source));
  const artifactFile = path.join(dir, "TokenSwap.json");
  const dbgFile = path.join(dir, "TokenSwap.dbg.json");
  if (!fs.existsSync(artifactFile) || !fs.existsSync(dbgFile)) {
    throw new Error(`Missing artifacts for ${source}. Run \`npx hardhat compile\` first.`);
  }
  const artifact = readJson(artifactFile);
  const buildInfoFile = path.resolve(dir, readJson(dbgFile).buildInfo);
  if (!fs.existsSync(buildInfoFile)) {
    throw new Error(`Missing build-info for ${source}. Run \`npx hardhat compile\` first.`);
  }
  const buildInfo = readJson(buildInfoFile);
  const output = buildInfo.output.contracts[source] && buildInfo.output.contracts[source].TokenSwap;
  if (!output) throw new Error(`Build-info ${path.basename(buildInfoFile)} has no TokenSwap output for ${source}`);
  return {
    source,
    artifact,
    buildInfo,
    immutableReferences: output.evm.deployedBytecode.immutableReferences || {},
    sections: splitCreationCode(artifact),
  };
}

// Checks the compiler profile of one build against the audited profile.
function settingsFailures(build) {
  const failures = [];
  const settings = build.buildInfo.input.settings || {};
  const label = build.source;
  if (build.buildInfo.solcLongVersion !== EXPECTED_SOLC) {
    failures.push(`${label}: solc ${build.buildInfo.solcLongVersion}, expected ${EXPECTED_SOLC}`);
  }
  const optimizer = settings.optimizer || {};
  if (optimizer.enabled !== true || optimizer.runs !== 1000000) {
    failures.push(`${label}: optimizer ${JSON.stringify(optimizer)}, expected enabled with 1000000 runs`);
  }
  if (settings.evmVersion !== undefined && settings.evmVersion !== "london") {
    failures.push(`${label}: evmVersion ${settings.evmVersion}, expected london`);
  }
  const bytecodeHash = settings.metadata && settings.metadata.bytecodeHash;
  if (bytecodeHash !== undefined && bytecodeHash !== "ipfs") {
    failures.push(`${label}: metadata.bytecodeHash ${bytecodeHash}, expected ipfs`);
  }
  return failures;
}

const comparableSettings = (settings) => JSON.stringify({ ...settings, outputSelection: undefined });

function openZeppelinSources(build) {
  return Object.fromEntries(
    Object.entries(build.buildInfo.input.sources)
      .filter(([name]) => name.startsWith(OZ_PREFIX))
      .map(([name, { content }]) => [name, content])
  );
}

function buildFailures(audited, variant) {
  const failures = settingsFailures(variant);
  if (comparableSettings(variant.buildInfo.input.settings) !== comparableSettings(audited.buildInfo.input.settings)) {
    failures.push(`${variant.source}: compiler settings differ from the audited build`);
  }
  const auditedOz = openZeppelinSources(audited);
  const variantOz = openZeppelinSources(variant);
  const names = new Set([...Object.keys(auditedOz), ...Object.keys(variantOz)]);
  for (const name of [...names].sort()) {
    if (auditedOz[name] !== variantOz[name]) failures.push(`${variant.source}: ${name} differs from the audited build`);
  }
  return failures;
}

function proveVariant(audited, variant, ratio) {
  const report = compareVariant({
    audited: audited.sections,
    variant: variant.sections,
    auditedRatio: AUDITED.ratio,
    variantRatio: ratio,
    immutableReferences: { audited: audited.immutableReferences, variant: variant.immutableReferences },
    expectedRatioSites: EXPECTED_RATIO_SITES,
  });
  const failures = [...buildFailures(audited, variant), ...report.failures];
  return { source: variant.source, ratio, ...report, ok: failures.length === 0, failures };
}

// Compares the Foundry artifact of a build with its Hardhat artifact, init code and runtime without metadata.
function compareForge(build, forgeOut) {
  const file = path.join(forgeOut, path.relative("contracts", build.source), "TokenSwap.json");
  if (!fs.existsSync(file)) return { source: build.source, ok: false, message: `missing ${file}` };
  const forge = readJson(file);
  let sections;
  try {
    sections = splitCreationCode({ bytecode: forge.bytecode.object, deployedBytecode: forge.deployedBytecode.object });
  } catch (error) {
    return { source: build.source, ok: false, message: error.message };
  }
  const differing = ["initCode", "runtime"].filter((name) => sections[name] !== build.sections[name]);
  return { source: build.source, ok: differing.length === 0, message: differing.length ? `${differing.join(", ")} differ` : "" };
}

function rpcCall(url, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 30000 },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error(`RPC HTTP ${response.statusCode}`));
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(`RPC error: ${parsed.error.message}`));
            resolve(parsed.result);
          } catch (error) {
            reject(new Error(`RPC returned invalid JSON: ${error.message}`));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("RPC request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

async function proveOnchain(audited, rpcUrl) {
  let code;
  try {
    code = await rpcCall(rpcUrl, "eth_getCode", [ONCHAIN_ADDRESS, "latest"]);
  } catch (error) {
    return { address: ONCHAIN_ADDRESS, ok: false, message: error.message };
  }
  if (typeof code !== "string" || code.length <= 2) {
    return { address: ONCHAIN_ADDRESS, ok: false, message: "No code at the address" };
  }
  const result = compareRuntimeWithOnchain({
    compiled: audited.artifact.deployedBytecode,
    onchain: code,
    immutableReferences: audited.immutableReferences,
  });
  return { address: ONCHAIN_ADDRESS, ...result };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--onchain" || flag === "--json" || flag === "--forge-out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      options[flag.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument ${flag}`);
    }
  }
  return options;
}

function printReport(result) {
  console.log(`\n== ${result.source} (SWAP_RATIO ${AUDITED.ratio} -> ${result.ratio}) ==`);
  for (const [name, section] of Object.entries(result.sections)) {
    const { audited, variant } = section.instructionCount;
    console.log(`${name}: ${audited}/${variant} instructions, ${section.differences.length} differing`);
    for (const d of section.differences) {
      const offsets = `0x${d.auditedOffset.toString(16).padStart(4, "0")}/0x${d.variantOffset.toString(16).padStart(4, "0")}`;
      console.log(`  [${d.index}] @${offsets} ${d.audited} -> ${d.variant} (${d.kind}: ${d.detail})`);
    }
  }
  const counts = Object.entries(result.counts).map(([kind, count]) => `${kind} ${count}`).join(", ");
  console.log(`summary: ${result.ok ? "OK" : "FAILED"} (${counts})`);
  for (const failure of result.failures) console.log(`  FAIL ${failure}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const audited = loadBuild(AUDITED.source);
  const report = { audited: AUDITED.source, auditedFailures: settingsFailures(audited), variants: [] };
  for (const failure of report.auditedFailures) console.log(`FAIL ${failure}`);

  const builds = [audited];
  for (const { source, ratio } of VARIANTS) {
    const variant = loadBuild(source);
    builds.push(variant);
    const result = proveVariant(audited, variant, ratio);
    report.variants.push(result);
    printReport(result);
  }

  if (options["forge-out"]) {
    report.forge = builds.map((build) => compareForge(build, options["forge-out"]));
    console.log("");
    for (const { source, ok, message } of report.forge) console.log(`forge ${source}: ${ok ? "OK" : `FAILED (${message})`}`);
  }

  if (options.onchain) {
    report.onchain = await proveOnchain(audited, options.onchain);
    const { ok, length, message } = report.onchain;
    console.log(`\nonchain ${ONCHAIN_ADDRESS}: ${ok ? `OK (${length} bytes match)` : `FAILED (${message})`}`);
  }

  report.ok = report.auditedFailures.length === 0 && report.variants.every((v) => v.ok) && (!report.onchain || report.onchain.ok) &&
    (!report.forge || report.forge.every((f) => f.ok));
  if (options.json) fs.writeFileSync(options.json, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nresult: ${report.ok ? "OK" : "FAILED"}`);
  return report.ok;
}

if (require.main === module) {
  main().then(
    (ok) => process.exit(ok ? 0 : 1),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}

module.exports = { loadBuild, proveVariant, compareForge, settingsFailures, VARIANTS, AUDITED, EXPECTED_RATIO_SITES };
