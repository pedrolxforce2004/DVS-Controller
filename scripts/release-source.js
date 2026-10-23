const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const destination = path.join(root, 'artifacts', `github-${version}`);
if (fs.existsSync(destination)) throw new Error(`Destino ja existe: ${destination}. Preserve ou remova explicitamente antes de gerar novamente.`);
const entries = ['server.js', 'launcher.js', 'stop.js', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes', '.env.example', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'lib', 'public', 'manager', 'service', 'installer', 'scripts', 'tests', 'webos-client', 'tizen-client', 'android-client', 'docs', '.github', 'build', 'vendor/WinSW-LICENSE.txt'];
const denied = /(^|\/)(node_modules|\.gradle|\.git|__pycache__|artifacts|evidence|data)(\/|$)|\.(p12|pfx|pem|key|keystore|jks|log|pyc|apk|exe|zip|ipk|wgt)$/i;
const manifest = [];
function copy(relative) {
  if (denied.test(relative) || relative === 'android-client/local.properties' || relative.startsWith('android-client/app/build/') || relative.startsWith('android-client/build/')) return;
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`Arquivo ausente: ${relative}`);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Link simbolico inesperado: ${relative}`);
  if (stat.isDirectory()) { for (const name of fs.readdirSync(source).sort()) copy(`${relative}/${name}`); return; }
  const target = path.join(destination, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  manifest.push(`${crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')}  ${relative}`);
}
for (const entry of entries) copy(entry);
fs.writeFileSync(path.join(destination, 'SOURCE-SHA256SUMS.txt'), manifest.join('\n') + '\n');
console.log(`Fonte publico: ${destination} (${manifest.length} arquivos; dados, certificados e ferramentas locais excluidos)`);
