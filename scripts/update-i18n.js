const fs = require('fs');
const path = require('path');

const messagesDir = path.join(__dirname, '../apps/website/messages');
const enPath = path.join(messagesDir, 'en.json');
const svPath = path.join(messagesDir, 'sv.json');

const enData = JSON.parse(fs.readFileSync(enPath, 'utf8'));

const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json') && f !== 'en.json' && f !== 'sv.json');

files.forEach(file => {
  const filePath = path.join(messagesDir, file);
  let data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  let modified = false;

  // Ensure nav.guides exists
  if (!data.nav) data.nav = {};
  if (!data.nav.guides) {
    data.nav.guides = enData.nav.guides;
    modified = true;
  }

  // Ensure guides object exists
  if (!data.guides) {
    data.guides = enData.guides;
    modified = true;
  } else {
    // Check inner guides
    for (const guideKey in enData.guides) {
      if (!data.guides[guideKey]) {
        data.guides[guideKey] = enData.guides[guideKey];
        modified = true;
      } else {
        // Check inner keys of the guide
        for (const k in enData.guides[guideKey]) {
          if (!data.guides[guideKey][k]) {
            data.guides[guideKey][k] = enData.guides[guideKey][k];
            modified = true;
          }
        }
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
    console.log(`Updated ${file}`);
  }
});

console.log('All translation files updated with fallbacks.');
