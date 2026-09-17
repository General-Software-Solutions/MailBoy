// Wraps a packed zip in a CRX3 container, signed with an RSA key.
//
//   node tools/crx.mjs --zip dist/mailboy-0.2.0.zip --out dist/mailboy-0.2.0.crx \
//                      --key C:\Users\you\keys\mailboy-upload.pem
//
// Called by tools/package.ps1; there is no reason to run it by hand except to
// re-sign a zip you already have. With no --key it mints a throwaway key and
// signs with that, which produces a valid CRX that the Web Store will not
// accept for a verified upload — package.ps1 names those "_unsigned".
//
// Chrome's own `--pack-extension` does the same job, and is what Google's docs
// point at. It is not used here for two reasons: it packs a *directory*, so the
// uploaded zip and the uploaded crx would be two separate acts of packing that
// could disagree, and it wants a display on Linux, which a CI runner has not
// got. Signing the finished zip keeps the two byte-identical and needs nothing
// but Node's own crypto.
//
// CRX3 is: "Cr24", version, header length, a protobuf header, then the zip
// unchanged. The header carries the public key and a signature over
// "CRX3 SignedData\0" + the signed header + the zip. Format per Chromium's
// components/crx_file/crx3.proto and crx_creator.cc.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'utf8');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!name.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`Bad arguments near "${name}". Expected --zip <path> --out <path> [--key <path>].`);
    }
    out[name.slice(2)] = argv[i + 1];
  }
  if (!out.zip || !out.out) throw new Error('Both --zip and --out are required.');
  return out;
}

/** A protobuf varint, which is what both a field tag and a length are. */
function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** One length-delimited protobuf field: tag, length, payload. */
function field(number, payload) {
  return Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload]);
}

function uint32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/**
 * The extension ID Chrome derives from a public key: the first 16 bytes of its
 * SHA-256, hex, with 0-9a-f mapped to a-p. Printed so a signed build can be
 * checked against the store listing's ID at a glance.
 */
function extensionId(publicKeyDer) {
  const digest = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
  return [...digest].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
}

function loadKey(path) {
  let pem;
  try {
    pem = readFileSync(path);
  } catch (err) {
    throw new Error(`Cannot read the signing key at ${path}: ${err.message}`);
  }
  try {
    return createPrivateKey(pem);
  } catch (err) {
    // Almost always a passphrase-protected key, a public key by mistake, or a
    // file that is not PEM at all.
    throw new Error(`${path} is not a usable unencrypted private key: ${err.message}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const archive = readFileSync(args.zip);

const privateKey = args.key
  ? loadKey(args.key)
  : generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
if (publicKeyDer.length === 0) throw new Error('The key produced no public half.');

// SignedData { crx_id = 1 }, which binds the signature to this one key.
const signedHeaderData = field(1, createHash('sha256').update(publicKeyDer).digest().subarray(0, 16));

const signedPayload = Buffer.concat([
  SIGNATURE_CONTEXT,
  uint32(signedHeaderData.length),
  signedHeaderData,
  archive,
]);
// RSA defaults to PKCS#1 v1.5 here, which is what CRX3 expects.
const signature = sign('sha256', signedPayload, privateKey);

// The store rejects a CRX it cannot verify with no useful reason given, so
// check our own work rather than finding out at upload time.
if (!verify('sha256', signedPayload, createPublicKey(privateKey), signature)) {
  throw new Error('The signature does not verify against its own key.');
}

// CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10000 }
const proof = Buffer.concat([field(1, publicKeyDer), field(2, signature)]);
const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);

writeFileSync(args.out, Buffer.concat([
  Buffer.from('Cr24', 'utf8'),
  uint32(3),
  uint32(header.length),
  header,
  archive,
]));

const how = args.key ? `signed with ${args.key}` : 'signed with a throwaway key';
console.log(`Built ${args.out} (${how}, extension ID ${extensionId(publicKeyDer)})`);
