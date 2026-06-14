/* Verifies the inline JS in index.html parses (catches brace/paren mistakes). */
const path = require('path');
const { syntaxCheck } = require('./_setup.cjs');
const INDEX = path.join(__dirname, '..', 'index.html');
try {
  syntaxCheck(INDEX);
  console.log('✅ syntax OK');
} catch (e) {
  console.error('❌ syntax error:', e.message);
  process.exit(1);
}
