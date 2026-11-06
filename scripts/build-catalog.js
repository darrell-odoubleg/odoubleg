// node scripts/build-catalog.js "<Rider Backline Gear List.xlsx>"
// Rebuilds data/catalog.json from the workbook's Gear Totals tab. The catalog is
// public, so it holds only gear names, categories and makes: never act names,
// act counts or anything else from a rider.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const SKIP = new Set(['Keyboard stand accessory', 'Empty case']); // not something anyone rents
const HEAD_MAKES = new Set(['Remo', 'Evans']); // these are drumhead brands, not drum makers
const HEAD_ITEMS = new Set(['Drum heads', 'Kick drum patch']);

const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/build-catalog.js <workbook.xlsx>'); process.exit(1); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.getWorksheet('Gear Totals');
  const rows = [];
  sheet.eachRow((r, i) => {
    if (i === 1) return;
    const category = r.getCell(1).value;
    const name = r.getCell(2).value;
    if (!category || !name || SKIP.has(name)) return;
    const demand = (Number(r.getCell(4).value) || 0) + (Number(r.getCell(5).value) || 0);
    if (!demand) return; // no act ever asked a buyer for this one
    // "DW (39), Yamaha (20)": a make asked for by a single act is too thin to suggest.
    const makes = [...String(r.getCell(9).value || '').matchAll(/([^,(]+?) \((\d+)\)/g)]
      .filter((m) => Number(m[2]) >= 2)
      .map((m) => m[1].trim())
      .filter((m) => HEAD_ITEMS.has(name) || !HEAD_MAKES.has(m));
    rows.push({ id: slug(name), name, category, makes, demand });
  });

  const categories = [...new Set(rows.map((r) => r.category))];
  const popular = [...rows].sort((a, b) => b.demand - a.demand).slice(0, 12).map((r) => r.id);
  const items = rows.map(({ demand, ...r }) => r);
  if (new Set(items.map((i) => i.id)).size !== items.length) throw new Error('Duplicate gear id');

  const out = path.join(__dirname, '..', 'data', 'catalog.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ categories, popular, items }, null, 1) + '\n');
  console.log(`${items.length} items in ${categories.length} categories -> ${out}`);
})();
