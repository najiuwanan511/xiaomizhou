// QQ Electron loads this instead of its desktop UI. The unmodified SnowCat
// distribution runs inside the QQ runtime and loads its matching native modules.
const { pathToFileURL } = require('node:url');
const entry = process.env.XIAOMIZHOU_NAPCAT_ENTRY;
if (!entry) throw new Error('Missing bundled SnowCat entry');
import(pathToFileURL(entry).href).catch(error => {
  console.error('Bundled QQ core failed to start:', error.code || error.name);
  process.exit(1);
});
