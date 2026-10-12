import crypto from "crypto";

export type EncryptedToken = {
  ciphertext: string;
  iv: string;
  tag: string;
};

function getKey(): Buffer {
  const raw: string | undefined = process.env.GBP_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("GBP_TOKEN_ENCRYPTION_KEY is not configured");
  }
  const maybeBase64 = Buffer.from(raw, "base64");
  if (maybeBase64.length === 32 && maybeBase64.toString("base64") === raw) {
    return maybeBase64;
  }
  const utf8 = Buffer.from(raw, "utf8");
  if (utf8.length === 32) {
    return utf8;
  }
  throw new Error("GBP_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
}

export function encryptRefreshToken(plainToken: string): EncryptedToken {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptRefreshToken(encrypted: EncryptedToken): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
