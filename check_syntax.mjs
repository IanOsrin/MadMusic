import { readFileSync } from 'fs';
import { parseArgs } from 'util';

const src = readFileSync('/Users/ianosrin/Desktop/Mass-Music/server.js', 'utf8');
const lines = src.split('\n');
console.log('Total lines: ' + lines.length);

// Try to find obvious syntax issues by checking brace/paren balance
let braces = 0, parens = 0, brackets = 0;
let lastBraceOpen = 0, lastParenOpen = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (const ch of line) {
    if (ch === '{') { braces++; lastBraceOpen = i + 1; }
    if (ch === '}') { braces--; }
    if (ch === '(') { parens++; lastParenOpen = i + 1; }
    if (ch === ')') { parens--; }
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }
  if (braces < 0) { console.log('Extra } at line ' + (i+1)); break; }
  if (parens < 0) { console.log('Extra ) at line ' + (i+1)); break; }
  if (brackets < 0) { console.log('Extra ] at line ' + (i+1)); break; }
}
console.log('End balance - braces:' + braces + ' parens:' + parens + ' brackets:' + brackets);
if (braces > 0) console.log('Last { opened at line ' + lastBraceOpen);
if (parens > 0) console.log('Last ( opened at line ' + lastParenOpen);
