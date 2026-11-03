// node scripts/lasso-sync.js [--dry-run] [--overwrite] [--include-new]
// Same as "Download from Lasso" on the Upload Files tab, from the command line.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { runLassoSync } = require('../server/twn');

const flag = f => process.argv.includes(f);
console.log(`--- ${new Date().toISOString()}`);
runLassoSync({ dry_run: flag('--dry-run'), overwrite: flag('--overwrite'), include_new: flag('--include-new') })
  .then(r => {
    console.log(`${r.dry_run ? 'DRY RUN: ' : ''}${r.lasso_crew} Lasso crew, ${r.people_matched} matched (ID ${r.matched_by['User ID']}, email ${r.matched_by.email}, name ${r.matched_by.name}); ${r.records_updated} records updated, ${r.created} added; ${r.linked_ids} people linked across two IDs.`);
    console.log('Filled:', Object.entries(r.filled).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing');
    for (const c of r.status_changes || []) console.log(`Status: ${c.who} (Lasso ${c.lasso}) ${c.from} -> ${c.to}${c.term_date ? ', termination date ' + c.term_date : ''}`);
    if (r.conflicts.length) console.log(`${r.conflicts.length} values differ from Lasso (${r.dry_run || !r.conflicts[0].replaced ? 'kept' : 'replaced'}).`);
    process.exit(0);
  })
  .catch(e => { console.error(e.userMessage || e.message); process.exit(1); });
