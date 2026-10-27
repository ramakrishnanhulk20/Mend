/**
 * Throwaway certificates for the webhook signature tests, built with node:crypto when a
 * test file loads, so no private key is ever stored in the repo. The DER writer below
 * covers exactly the X.509 fields these tests need: version 3, a serial, SHA-256 with
 * RSA, names of an organisation and a common name, validity, the public key, and the
 * basic constraints, key usage and CA Issuers extensions.
 */
import { generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";

function encode(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content]);
  if (length < 0x100) return Buffer.concat([Buffer.from([tag, 0x81, length]), content]);
  if (length < 0x10000) return Buffer.concat([Buffer.from([tag, 0x82, length >> 8, length & 0xff]), content]);
  throw new Error("DER value too long for these fixtures");
}

const sequence = (...parts: Buffer[]) => encode(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => encode(0x31, Buffer.concat(parts));
const explicit = (number: number, inner: Buffer) => encode(0xa0 + number, inner);
const octets = (bytes: Buffer) => encode(0x04, bytes);
const bits = (bytes: Buffer, unused = 0) => encode(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
const boolean = (value: boolean) => encode(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8 = (text: string) => encode(0x0c, Buffer.from(text, "utf8"));
const NULL = Buffer.from([0x05, 0x00]);

function integer(bytes: Buffer): Buffer {
  return encode(0x02, bytes[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) groups.unshift((value & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return encode(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const digits = date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return date.getUTCFullYear() < 2050 ? encode(0x17, Buffer.from(`${digits.slice(2)}Z`)) : encode(0x18, Buffer.from(`${digits}Z`));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(objectId("2.5.4.10"), utf8("Mend Test"))), set(sequence(objectId("2.5.4.3"), utf8(commonName))));
}

const SHA256_WITH_RSA = sequence(objectId("1.2.840.113549.1.1.11"), NULL);

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? sequence(objectId(id), boolean(true), octets(value)) : sequence(objectId(id), octets(value));
}

export type KeyPair = { readonly publicKey: KeyObject; readonly privateKey: KeyObject };

export function rsaKeys(): KeyPair {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** One certificate, its PEM and DER, and the key pair it certifies. */
export type Issued = {
  readonly commonName: string;
  readonly pem: string;
  readonly der: Buffer;
  readonly cert: X509Certificate;
  readonly keys: KeyPair;
};

export type CertificateSpec = {
  readonly commonName: string;
  readonly keys: KeyPair;
  /** The certificate whose subject becomes the issuer name; none means self-signed. */
  readonly issuer?: Issued;
  /** Sign with this key instead of the issuer's, to make a signature that does not check. */
  readonly signWith?: KeyObject;
  /** True writes CA:TRUE with keyCertSign, false writes CA:FALSE with digitalSignature. */
  readonly ca: boolean;
  /** False leaves out key usage, so only the basic constraints say what the certificate may do. */
  readonly keyUsage?: boolean;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  readonly caIssuersUrl?: string;
};

export const LONG_AGO = new Date(Date.UTC(2000, 0, 1));
export const FAR_AHEAD = new Date(Date.UTC(2099, 11, 31, 23, 59, 59));

export function issue(spec: CertificateSpec): Issued {
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const extensions = [extension("2.5.29.19", true, spec.ca ? sequence(boolean(true)) : sequence())];
  if (spec.keyUsage !== false) {
    extensions.push(extension("2.5.29.15", true, spec.ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)));
  }
  if (spec.caIssuersUrl !== undefined) {
    const access = sequence(objectId("1.3.6.1.5.5.7.48.2"), encode(0x86, Buffer.from(spec.caIssuersUrl, "ascii")));
    extensions.push(extension("1.3.6.1.5.5.7.1.1", false, sequence(access)));
  }
  const subject = name(spec.commonName);
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    SHA256_WITH_RSA,
    spec.issuer === undefined ? subject : name(spec.issuer.commonName),
    sequence(time(spec.notBefore ?? LONG_AGO), time(spec.notAfter ?? FAR_AHEAD)),
    subject,
    spec.keys.publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(...extensions)),
  );
  const signingKey = spec.signWith ?? spec.issuer?.keys.privateKey ?? spec.keys.privateKey;
  const der = sequence(tbs, SHA256_WITH_RSA, bits(sign("sha256", tbs, signingKey)));
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { commonName: spec.commonName, pem, der, cert: new X509Certificate(der), keys: spec.keys };
}

export const SANDBOX_SIGNING_NAME = "messageverificationcerts.sandbox.paypal.com";

/**
 * A root, an intermediate under it and a sandbox signing leaf under that, plus one
 * certificate for each way a chain must fail. Built once per test file.
 */
export function testChain() {
  const rootKeys = rsaKeys();
  const intermediateKeys = rsaKeys();
  const leafKeys = rsaKeys();
  const strangerKeys = rsaKeys();
  const root = issue({ commonName: "Mend Test Root", keys: rootKeys, ca: true });
  const intermediate = issue({ commonName: "Mend Test Intermediate", keys: intermediateKeys, issuer: root, ca: true });
  const leafUnder = (overrides: Partial<CertificateSpec> = {}) =>
    issue({ commonName: SANDBOX_SIGNING_NAME, keys: leafKeys, issuer: intermediate, ca: false, ...overrides });
  const stranger = issue({ commonName: "Mend Test Stranger CA", keys: strangerKeys, ca: true });
  const notCa = issue({ commonName: "Mend Test Not A CA", keys: strangerKeys, issuer: intermediate, ca: false, keyUsage: false });
  return {
    root,
    intermediate,
    leaf: leafUnder(),
    leafKeys,
    // The intermediate is fetched from DigiCert's host rather than found in the bundle.
    leafWithIssuerUrl: (url: string) => leafUnder({ caIssuersUrl: url }),
    liveName: leafUnder({ commonName: "messageverificationcerts.paypal.com" }),
    lookalikeName: leafUnder({ commonName: "messageverificationcerts.sandbox.paypal.com.evil.example" }),
    expired: leafUnder({ notBefore: new Date(Date.UTC(2020, 0, 1)), notAfter: new Date(Date.UTC(2021, 0, 1)) }),
    notYetValid: leafUnder({ notBefore: new Date(Date.UTC(2098, 0, 1)) }),
    badSignature: leafUnder({ signWith: strangerKeys.privateKey }),
    caLeaf: leafUnder({ ca: true }),
    unknownIssuer: issue({
      commonName: SANDBOX_SIGNING_NAME,
      keys: leafKeys,
      issuer: stranger,
      ca: false,
      caIssuersUrl: "http://certs.evil.example/stranger.crt",
    }),
    stranger,
    notCa,
    underNotCa: issue({ commonName: SANDBOX_SIGNING_NAME, keys: leafKeys, issuer: notCa, ca: false }),
  };
}

export type TestChain = ReturnType<typeof testChain>;
