// One-time: add the numbered spots from the printed fairgrounds map (assets/fairgrounds-map.png) as locations.
// x/y are image pixels on the 1680×1100 map. Names that already exist are skipped, so it is safe to re-run.
const { db } = require('../server/db');

const SPOTS = [
  [1, "Horseman's Gate", 345, 254],
  [2, "Rodeo Headquarters", 417, 261],
  [3, "Horse Barns", 956, 329],
  [4, "4-H, Schools, Creative Arts, Quilts", 273, 413],
  [5, "Night Shows Box Office", 335, 293],
  [6, "Commissary", 464, 347],
  [7, "Rodeo Office", 487, 472],
  [8, "Grandstand", 735, 465],
  [9, "Horse Racing Betting Window", 497, 525],
  [10, "Montana Lottery Club", 529, 525],
  [11, "Gold Buckle Room", 561, 525],
  [12, "First Aid", 593, 525],
  [13, "Entry Office & Commercial Vendor Office", 444, 638],
  [14, "Mercantile Commercial Vendors", 625, 525],
  [15, "Trades & Industries Commercial Vendors", 657, 525],
  [16, "Floriculture", 689, 525],
  [17, "Photography", 721, 525],
  [18, "Fine Arts", 753, 525],
  [19, "Information Booth", 683, 613],
  [20, "Central Park Commercial Vendors", 500, 645],
  [21, "Eagles Landing", 536, 632],
  [22, "3 Rivers Stage", 573, 632],
  [23, "Antique Cars & Tractors", 618, 978],
  [24, "Nature's Den", 683, 645],
  [25, "Flippin Family Fun Stunt Jump Free Fall", 609, 645],
  [26, "MT Museum of Railroad History", 546, 739],
  [27, "Ponies & Mini Horses Show Arena", 303, 743],
  [28, "Zion School", 337, 743],
  [29, "Culinary, Home Arts", 409, 743],
  [30, "Securitas Security", 514, 814],
  [31, "Ponies & Mini Horses", 351, 658],
  [32, "Garden, Hobbies, Weaving & Wool", 389, 658],
  [33, "Open Class Livestock, Jr. Livestock Show & Sale", 166, 623],
  [34, "Poultry, Rabbits, Pigeons", 166, 383],
  [35, "Draft Mules and FFA", 166, 503],
  [36, "Horse Racing Office", 945, 385],
  [0, "Pacific Steel & Recycling Arena", 382, 350],
  [0, "Racetrack", 701, 339],
  [0, "Mighty Thomas Carnival", 344, 560],
  [0, "Food Alley", 449, 600],
  [0, "Kids Carnival", 621, 880],
  [0, "Rodeo Arena", 487, 440],
  [0, "Livestock Barns", 166, 560],
];

const exists = db.prepare('SELECT 1 FROM locations WHERE lower(name) = lower(?)');
const insert = db.prepare("INSERT INTO locations (name, map_id, x, y, notes, sort) VALUES (?, 'fairgrounds', ?, ?, ?, ?)");
let added = 0;
db.transaction(() => {
  SPOTS.forEach(([n, name, x, y], i) => {
    if (exists.get(name)) return;
    insert.run(name, x, y, n ? `Map #${n}` : null, n || 100 + i);
    added++;
  });
})();
console.log(`Added ${added} of ${SPOTS.length} fairgrounds locations.`);
