#!/usr/bin/env node
// Moves the fairgrounds pins onto the 2026 Fair Guide map (assets/fairgrounds-map-2026.jpg,
// the guide's pages 2-3 as one 2400×1855 image). x/y are image pixels. Safe to run again.
const { db } = require('../server/db');

const SPOTS = {
  "Horseman's Gate": [760, 262],
  'Rodeo Headquarters': [1170, 490],
  'Horse Barns': [1447, 400],
  '4-H, Schools, Creative Arts, Quilts': [615, 492],
  'Night Shows Box Office': [705, 520],
  'Commissary': [740, 765],
  'Rodeo Office': [810, 705],
  'Grandstand': [858, 785],
  'Horse Racing Betting Window': [960, 842],
  'Montana Lottery Club': [890, 855],
  'Gold Buckle Room': [905, 882],
  'First Aid': [822, 1105],
  'Entry Office & Commercial Vendor Office': [868, 1085],
  'Mercantile Commercial Vendors': [925, 1050],
  'Trades & Industries Commercial Vendors': [985, 978],
  'Floriculture': [1035, 948],
  'Photography': [1062, 942],
  'Fine Arts': [1115, 962],
  'Information Booth': [1050, 1082],
  'Central Park Commercial Vendors': [910, 1137],
  'Eagles Landing': [980, 1142],
  '3 Rivers Stage': [955, 1232],
  'Antique Cars & Tractors': [1035, 1522],
  "Nature's Den": [930, 1425],
  'Flippin Family Fun Stunt Jump Free Fall': [870, 1202],
  'MT Museum of Railroad History': [893, 1322],
  'Ponies & Mini Horses Show Arena': [793, 1347],
  'Zion School': [850, 1305],
  'Culinary, Home Arts': [800, 1235],
  'Securitas Security': [755, 1262],
  'Ponies & Mini Horses': [722, 1207],
  'Garden, Hobbies, Weaving & Wool': [765, 1180],
  'Open Class Livestock, Jr. Livestock Show & Sale': [655, 1025],
  'Poultry, Rabbits, Pigeons': [520, 822],
  'Draft Mules and FFA': [358, 680],
  'Horse Racing Office': [1150, 455],
  'Pacific Steel & Recycling Arena': [650, 580],
  'Racetrack': [1000, 560],
  'Mighty Thomas Carnival': [770, 950],
  'Food Alley': [840, 900],
  'Kids Carnival': [1045, 1385],
  'Rodeo Arena': [945, 740],
  'Livestock Barns': [560, 905],
  'Exhibition Hall': [592, 482],
  'Mercantile Building': [885, 1045],
  'Fine Arts Building': [1092, 942],
  'FFA Barn': [392, 657],
  'Family Living Center': [820, 1260],
  'Livestock Pavilion': [625, 1000],
  'Rabbit/Poultry Barn': [505, 795],
  'Pony Barn': [705, 1182],
  'South Park': [1062, 1327],
};

const move = db.prepare("UPDATE locations SET x = ?, y = ? WHERE name = ? AND map_id = 'fairgrounds'");
const run = db.transaction(() => {
  let n = 0;
  for (const [name, [x, y]] of Object.entries(SPOTS)) {
    if (move.run(x, y, name).changes) n++;
    else console.warn(`No fairgrounds location named "${name}"`);
  }
  return n;
});
console.log(`Moved ${run()} pins onto the 2026 guide map.`);
