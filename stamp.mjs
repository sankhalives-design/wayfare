/* Stamps the deploy time into the app at build time.
   The server refuses clients older than a floor (netlify/functions/_lib.mjs),
   which only works if builds are identifiable. Runs on every Netlify deploy. */
import { readFileSync, writeFileSync } from 'fs';

const FILE = 'public/index.html';
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

let html = readFileSync(FILE, 'utf8');
const before = html;
html = html.replace(
  /window\.WAYFARE_BUILD = window\.WAYFARE_BUILD \|\| "[^"]*";/,
  `window.WAYFARE_BUILD = "${stamp}";`
);
if (html === before) {
  console.error('stamp.mjs: could not find the build slot in ' + FILE);
  process.exit(1);
}
writeFileSync(FILE, html);
console.log('Wayfare build stamped: ' + stamp);
