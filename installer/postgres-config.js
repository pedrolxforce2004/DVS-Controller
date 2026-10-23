const fs = require("fs");
const path = require("path");

const BEGIN = "# BEGIN DVS CONTROLLER MANAGED SETTINGS";
const END = "# END DVS CONTROLLER MANAGED SETTINGS";

function updatePostgresConfiguration(databaseDir, config) {
  const target = path.join(databaseDir, "postgresql.conf");
  const managed = `${BEGIN}\nlisten_addresses = '127.0.0.1'\nport = ${config.databasePort}\npassword_encryption = 'scram-sha-256'\n${END}`;
  const current = fs.readFileSync(target, "utf8");
  const escapedBegin = BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${escapedBegin}[\\s\\S]*?${escapedEnd}`, "g");
  const next = block.test(current)
    ? current.replace(block, managed)
    : `${current.replace(/\s*$/, "")}\n\n${managed}\n`;
  fs.writeFileSync(target, next, "utf8");
}

module.exports = { BEGIN, END, updatePostgresConfiguration };
