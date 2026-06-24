import { parseArgs } from "node:util";
import { hashInviteCode } from "../apps/worker/src/index.js";

const { values } = parseArgs({
  options: {
    code: { type: "string" },
    label: { type: "string", default: "" },
    "max-uses": { type: "string", default: "1" },
    secret: { type: "string" },
  },
});

const code = String(values.code || "").trim();
const label = String(values.label || "")
  .trim()
  .slice(0, 80);
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
const escapedLabel = label.replaceAll("'", "''");
console.log(
  [
    "INSERT INTO invites (code_hash, label, max_uses, uses, reserved_uses)",
    `VALUES ('${codeHash}', '${escapedLabel}', ${maxUses}, 0, 0)`,
    "ON CONFLICT(code_hash) DO UPDATE SET label = excluded.label, max_uses = excluded.max_uses, reserved_uses = 0;",
  ].join(" ")
);
