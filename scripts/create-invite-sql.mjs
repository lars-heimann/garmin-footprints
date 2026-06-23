import { parseArgs } from "node:util";
import { hashInviteCode } from "../apps/worker/src/index.js";

const { values } = parseArgs({
  options: {
    code: { type: "string" },
    "max-uses": { type: "string", default: "1" },
    secret: { type: "string" },
  },
});

const code = String(values.code || "").trim();
const secret = String(values.secret || "");
const maxUses = Number(values["max-uses"]);

if (!code) {
  throw new Error("--code is required.");
}
if (!secret) {
  throw new Error("--secret is required.");
}
if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
  throw new Error("--max-uses must be an integer from 1 to 1000.");
}

const codeHash = await hashInviteCode(code, secret);
console.log(
  [
    "INSERT INTO invites (code_hash, max_uses, uses)",
    `VALUES ('${codeHash}', ${maxUses}, 0)`,
    "ON CONFLICT(code_hash) DO UPDATE SET max_uses = excluded.max_uses;",
  ].join(" ")
);
