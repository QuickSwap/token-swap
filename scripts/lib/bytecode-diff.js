// Instruction-level comparison of a ratio variant build against the audited TokenSwap build.
// Pure helpers: no Hardhat, no network, no file access.

const OPCODES = {
  0x00: "STOP", 0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x05: "SDIV", 0x06: "MOD", 0x07: "SMOD",
  0x08: "ADDMOD", 0x09: "MULMOD", 0x0a: "EXP", 0x0b: "SIGNEXTEND",
  0x10: "LT", 0x11: "GT", 0x12: "SLT", 0x13: "SGT", 0x14: "EQ", 0x15: "ISZERO", 0x16: "AND", 0x17: "OR",
  0x18: "XOR", 0x19: "NOT", 0x1a: "BYTE", 0x1b: "SHL", 0x1c: "SHR", 0x1d: "SAR",
  0x20: "KECCAK256",
  0x30: "ADDRESS", 0x31: "BALANCE", 0x32: "ORIGIN", 0x33: "CALLER", 0x34: "CALLVALUE", 0x35: "CALLDATALOAD",
  0x36: "CALLDATASIZE", 0x37: "CALLDATACOPY", 0x38: "CODESIZE", 0x39: "CODECOPY", 0x3a: "GASPRICE",
  0x3b: "EXTCODESIZE", 0x3c: "EXTCODECOPY", 0x3d: "RETURNDATASIZE", 0x3e: "RETURNDATACOPY", 0x3f: "EXTCODEHASH",
  0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT",
  0x46: "CHAINID", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE",
  0x50: "POP", 0x51: "MLOAD", 0x52: "MSTORE", 0x53: "MSTORE8", 0x54: "SLOAD", 0x55: "SSTORE", 0x56: "JUMP",
  0x57: "JUMPI", 0x58: "PC", 0x59: "MSIZE", 0x5a: "GAS", 0x5b: "JUMPDEST", 0x5c: "TLOAD", 0x5d: "TSTORE",
  0x5e: "MCOPY", 0x5f: "PUSH0",
  0xa0: "LOG0", 0xa1: "LOG1", 0xa2: "LOG2", 0xa3: "LOG3", 0xa4: "LOG4",
  0xf0: "CREATE", 0xf1: "CALL", 0xf2: "CALLCODE", 0xf3: "RETURN", 0xf4: "DELEGATECALL", 0xf5: "CREATE2",
  0xfa: "STATICCALL", 0xfd: "REVERT", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};

const JUMPDEST = 0x5b;
const KINDS = ["ratio", "code-offset", "code-length"];

function normalizeHex(hex) {
  const body = String(hex).replace(/^0x/i, "").toLowerCase();
  if (body.length % 2 !== 0 || !/^[0-9a-f]*$/.test(body)) {
    throw new Error(`Invalid hex string (${body.length} characters)`);
  }
  return body;
}

function opcodeName(opcode) {
  if (opcode >= 0x60 && opcode <= 0x7f) return `PUSH${opcode - 0x5f}`;
  if (opcode >= 0x80 && opcode <= 0x8f) return `DUP${opcode - 0x7f}`;
  if (opcode >= 0x90 && opcode <= 0x9f) return `SWAP${opcode - 0x8f}`;
  return OPCODES[opcode];
}

const isPush = (instruction) => instruction.opcode >= 0x5f && instruction.opcode <= 0x7f;

// Returns one entry per instruction: { index, offset, opcode, name, size, data, truncated }.
// `data` is the push payload as lowercase hex ("" for non-push opcodes and PUSH0).
function disassemble(hex) {
  const bytes = Buffer.from(normalizeHex(hex), "hex");
  const instructions = [];
  let offset = 0;
  while (offset < bytes.length) {
    const opcode = bytes[offset];
    const width = opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f : 0;
    const data = bytes.subarray(offset + 1, offset + 1 + width);
    instructions.push({
      index: instructions.length,
      offset,
      opcode,
      name: opcodeName(opcode) || `0x${opcode.toString(16).padStart(2, "0")}`,
      size: 1 + data.length,
      data: data.toString("hex"),
      truncated: data.length < width,
    });
    offset += 1 + width;
  }
  return instructions;
}

function formatInstruction(instruction) {
  if (!isPush(instruction) || instruction.opcode === 0x5f) return instruction.name;
  return `${instruction.name} 0x${instruction.data}${instruction.truncated ? " (truncated)" : ""}`;
}

// Splits off the CBOR metadata tail whose byte length is stored in the final two bytes.
function stripMetadata(hex) {
  const body = normalizeHex(hex);
  const total = body.length / 2;
  if (total < 2) throw new Error("Code is too short to carry a metadata length");
  const length = parseInt(body.slice(-4), 16);
  if (length + 2 > total) {
    throw new Error(`Declared metadata length ${length} exceeds the code size ${total}`);
  }
  const start = (total - length - 2) * 2;
  const firstByte = parseInt(body.slice(start, start + 2), 16);
  if (length === 0 || firstByte < 0xa0 || firstByte > 0xbf) {
    throw new Error("Metadata tail does not start with a CBOR map");
  }
  return { code: body.slice(0, start), metadata: body.slice(start) };
}

// Creation bytecode is the init code followed by the full runtime (including metadata).
function splitCreationCode({ bytecode, deployedBytecode }) {
  const creation = normalizeHex(bytecode);
  const runtimeFull = normalizeHex(deployedBytecode);
  if (!creation.endsWith(runtimeFull)) {
    throw new Error("Creation bytecode does not end with the runtime bytecode");
  }
  const { code, metadata } = stripMetadata(runtimeFull);
  return { initCode: creation.slice(0, creation.length - runtimeFull.length), runtime: code, metadata };
}

// Maps a byte position of the audited code to the variant code through the instruction alignment.
// The end-of-code position maps to the variant end; a position inside push data maps only when
// the variant instruction is wide enough to hold the same data byte.
function mapPosition(auditedInstructions, variantInstructions, auditedLength, variantLength, position) {
  if (position === auditedLength) return variantLength;
  if (position > auditedLength || auditedInstructions.length === 0) return null;
  let low = 0;
  let high = auditedInstructions.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (auditedInstructions[mid].offset <= position) low = mid;
    else high = mid - 1;
  }
  const audited = auditedInstructions[low];
  const variant = variantInstructions[low];
  const within = position - audited.offset;
  if (!variant || within >= audited.size || within >= variant.size) return null;
  return variant.offset + within;
}

function buildLayout(code, metadata = "") {
  const body = normalizeHex(code);
  const instructions = disassemble(body);
  return { instructions, length: body.length / 2, metadataLength: normalizeHex(metadata).length / 2 };
}

const pushValue = (instruction) => (instruction.data === "" ? 0n : BigInt(`0x${instruction.data}`));
const hex4 = (n) => `0x${Number(n).toString(16).padStart(4, "0")}`;

// Pairs the immutable reference starts of both builds by sorted AST id position and range order.
// Returns { pairs: Map<auditedStart, { start, detail }>, failures }.
function pairImmutables(immutableReferences, layouts) {
  const pairs = new Map();
  const failures = [];
  if (!immutableReferences) return { pairs, failures };
  const ordered = (refs) =>
    Object.keys(refs || {})
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => refs[id]);
  const audited = ordered(immutableReferences.audited);
  const variant = ordered(immutableReferences.variant);
  if (audited.length !== variant.length) {
    failures.push(`immutables: ${audited.length} audited vs ${variant.length} variant references`);
    return { pairs, failures };
  }
  const a = layouts.audited.runtime;
  const v = layouts.variant.runtime;
  audited.forEach((ranges, position) => {
    if (ranges.length !== variant[position].length) {
      failures.push(`immutables: reference ${position} has ${ranges.length} audited vs ${variant[position].length} variant ranges`);
      return;
    }
    ranges.forEach((range, order) => {
      const other = variant[position][order];
      const detail = `immutable ${position}[${order}] start`;
      const mapped = mapPosition(a.instructions, v.instructions, a.length, v.length, range.start);
      if (range.length !== other.length || mapped !== other.start) {
        failures.push(`${detail} ${hex4(range.start)} maps to ${mapped === null ? "nowhere" : hex4(mapped)}, variant start is ${hex4(other.start)}`);
        return;
      }
      pairs.set(range.start, { start: other.start, detail });
    });
  });
  return { pairs, failures };
}

// Each rule returns { value, detail } with the expected variant value for an audited value, or null.
// Code offsets are JUMPDEST positions of the same section or, in the init code, immutable starts
// of the runtime. Code lengths are the runtime start, both runtime lengths and the creation length.
function sectionRules(name, layouts, immutables) {
  const { audited, variant } = layouts;
  const jumpdest = (value) => {
    if (value > BigInt(audited[name].length)) return null;
    const position = Number(value);
    const a = audited[name];
    const v = variant[name];
    const target = a.instructions.find((ins) => ins.offset === position);
    if (!target || target.opcode !== JUMPDEST) return null;
    const mapped = mapPosition(a.instructions, v.instructions, a.length, v.length, position);
    const moved = v.instructions[target.index];
    if (mapped === null || !moved || moved.opcode !== JUMPDEST || moved.offset !== mapped) return null;
    return { value: mapped, detail: `${name} JUMPDEST` };
  };
  const offsets = [jumpdest];
  const lengths = [];
  if (name === "init") {
    offsets.push((value) => {
      const pair = value <= BigInt(Number.MAX_SAFE_INTEGER) ? immutables.get(Number(value)) : undefined;
      return pair ? { value: pair.start, detail: pair.detail } : null;
    });
    const full = (layout) => layout.runtime.length + layout.runtime.metadataLength;
    const quantities = [
      ["runtime start", (layout) => layout.init.length],
      ["full runtime length", full],
      ["stripped runtime length", (layout) => layout.runtime.length],
      ["creation length", (layout) => layout.init.length + full(layout)],
    ];
    for (const [detail, quantity] of quantities) {
      lengths.push((value) => (value === BigInt(quantity(audited)) ? { value: quantity(variant), detail } : null));
    }
  }
  return { offsets, lengths };
}

function classify(auditedValue, variantValue, rules, ratios) {
  if (auditedValue === ratios.audited && variantValue === ratios.variant) return { kind: "ratio", detail: "SWAP_RATIO" };
  const match = (list) => {
    for (const rule of list) {
      const expected = rule(auditedValue);
      if (expected !== null && BigInt(expected.value) === variantValue) return expected.detail;
    }
    return null;
  };
  const offset = match(rules.offsets);
  if (offset) return { kind: "code-offset", detail: offset };
  const length = match(rules.lengths);
  if (length) return { kind: "code-length", detail: length };
  return null;
}

function compareSection(name, layouts, ratios, immutables) {
  const audited = layouts.audited[name].instructions;
  const variant = layouts.variant[name].instructions;
  const differences = [];
  const failures = [];
  if (audited.length !== variant.length) {
    failures.push(`${name}: instruction count differs (${audited.length} vs ${variant.length})`);
    return { instructionCount: { audited: audited.length, variant: variant.length }, differences, failures };
  }

  const rules = sectionRules(name, layouts, immutables);
  const auditedLayout = layouts.audited[name];
  const variantLayout = layouts.variant[name];
  const jumpdests = new Set(audited.filter((ins) => ins.opcode === JUMPDEST).map((ins) => ins.offset));
  const ratioChanges = ratios.audited !== ratios.variant;

  for (let index = 0; index < audited.length; index += 1) {
    const a = audited[index];
    const v = variant[index];
    const where = `${name}[${index}] @${hex4(a.offset)}/${hex4(v.offset)}`;
    const bothPush = isPush(a) && isPush(v) && a.opcode !== 0x5f && v.opcode !== 0x5f;

    if (!bothPush) {
      if (a.opcode !== v.opcode) failures.push(`${where}: opcode ${formatInstruction(a)} -> ${formatInstruction(v)}`);
      continue;
    }
    if (a.truncated || v.truncated) {
      if (a.opcode !== v.opcode || a.data !== v.data) {
        failures.push(`${where}: truncated push ${formatInstruction(a)} -> ${formatInstruction(v)}`);
      }
      continue;
    }

    const auditedValue = pushValue(a);
    const variantValue = pushValue(v);
    if (ratioChanges && auditedValue === ratios.audited && variantValue !== ratios.variant) {
      const state = variantValue === auditedValue ? "still pushes the audited ratio" : "does not become the variant ratio";
      failures.push(`${where}: ${formatInstruction(a)} -> ${formatInstruction(v)} ${state}`);
      continue;
    }
    if (auditedValue === variantValue) {
      if (a.opcode !== v.opcode) {
        failures.push(`${where}: ${formatInstruction(a)} -> ${formatInstruction(v)} changes width without a value change`);
        continue;
      }
      // A push of a jump destination or an immutable start must follow it when it moves.
      if (auditedValue <= BigInt(auditedLayout.length) && jumpdests.has(Number(auditedValue))) {
        const moved = mapPosition(audited, variant, auditedLayout.length, variantLayout.length, Number(auditedValue));
        if (moved !== Number(auditedValue)) {
          failures.push(`${where}: jump destination ${hex4(auditedValue)} moved to ${moved === null ? "nowhere" : hex4(moved)} but the push is unchanged`);
        }
      } else if (name === "init" && auditedValue <= BigInt(Number.MAX_SAFE_INTEGER) && immutables.has(Number(auditedValue))) {
        const pair = immutables.get(Number(auditedValue));
        if (pair.start !== Number(auditedValue)) {
          failures.push(`${where}: ${pair.detail} ${hex4(auditedValue)} moved to ${hex4(pair.start)} but the push is unchanged`);
        }
      }
      continue;
    }

    const match = classify(auditedValue, variantValue, rules, ratios);
    if (!match) {
      failures.push(`${where}: ${formatInstruction(a)} -> ${formatInstruction(v)} is not a ratio, code offset or code length change`);
      continue;
    }
    differences.push({
      index,
      auditedOffset: a.offset,
      variantOffset: v.offset,
      audited: formatInstruction(a),
      variant: formatInstruction(v),
      kind: match.kind,
      detail: match.detail,
    });
  }
  return { instructionCount: { audited: audited.length, variant: variant.length }, differences, failures };
}

// Compares { initCode, runtime, metadata } of the audited and variant builds. `runtime` excludes
// the metadata tail; `metadata` is that tail (optional). An empty initCode skips the init section.
// `immutableReferences` ({ audited, variant }, solc format) enables immutable starts as init code
// offsets. `expectedRatioSites` ({ runtime, init }) fixes the number of ratio sites per section.
function compareVariant({ audited, variant, auditedRatio, variantRatio, immutableReferences, expectedRatioSites }) {
  const layouts = {
    audited: { init: buildLayout(audited.initCode || ""), runtime: buildLayout(audited.runtime, audited.metadata) },
    variant: { init: buildLayout(variant.initCode || ""), runtime: buildLayout(variant.runtime, variant.metadata) },
  };
  const ratios = { audited: BigInt(auditedRatio), variant: BigInt(variantRatio) };
  const immutables = pairImmutables(immutableReferences, layouts);
  const sections = { runtime: compareSection("runtime", layouts, ratios, immutables.pairs) };
  if (layouts.audited.init.length > 0 || layouts.variant.init.length > 0) {
    sections.init = compareSection("init", layouts, ratios, immutables.pairs);
  }

  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const failures = [...immutables.failures];
  for (const [name, result] of Object.entries(sections)) {
    result.counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    for (const difference of result.differences) {
      result.counts[difference.kind] += 1;
      counts[difference.kind] += 1;
    }
    failures.push(...result.failures);
    const expected = expectedRatioSites && expectedRatioSites[name];
    if (expected !== undefined && result.counts.ratio !== expected) {
      failures.push(`${name}: ${result.counts.ratio} ratio sites, expected ${expected}`);
    }
  }
  return { ok: failures.length === 0, auditedRatio: Number(auditedRatio), variantRatio: Number(variantRatio), sections, counts, failures };
}

function zeroRanges(body, immutableReferences) {
  const bytes = Buffer.from(body, "hex");
  for (const ranges of Object.values(immutableReferences || {})) {
    for (const { start, length } of ranges) {
      if (start + length > bytes.length) throw new Error(`Immutable range ${start}+${length} exceeds the code size ${bytes.length}`);
      bytes.fill(0, start, start + length);
    }
  }
  return bytes;
}

// Compares a compiled runtime with deployed runtime bytes: immutable ranges are zeroed in both
// and the metadata tails are removed before requiring byte equality.
function compareRuntimeWithOnchain({ compiled, onchain, immutableReferences }) {
  let compiledBody;
  let onchainBody;
  try {
    compiledBody = stripMetadata(compiled).code;
    onchainBody = stripMetadata(onchain).code;
  } catch (error) {
    return { ok: false, message: error.message };
  }
  if (compiledBody.length !== onchainBody.length) {
    return { ok: false, message: `Runtime length differs (${compiledBody.length / 2} vs ${onchainBody.length / 2})` };
  }
  let compiledCode;
  let onchainCode;
  try {
    compiledCode = zeroRanges(compiledBody, immutableReferences);
    onchainCode = zeroRanges(onchainBody, immutableReferences);
  } catch (error) {
    return { ok: false, message: error.message };
  }
  for (let i = 0; i < compiledCode.length; i += 1) {
    if (compiledCode[i] !== onchainCode[i]) {
      return { ok: false, message: `Runtime differs: first difference at byte ${i}` };
    }
  }
  return { ok: true, length: compiledCode.length };
}

module.exports = {
  disassemble,
  formatInstruction,
  stripMetadata,
  splitCreationCode,
  mapPosition,
  compareVariant,
  compareRuntimeWithOnchain,
};
