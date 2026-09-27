// Zips dist/ for Chrome Web Store upload.
import { execSync } from 'node:child_process';
execSync(
  'powershell -NoProfile -Command "Compress-Archive -Path \'dist/*\' -DestinationPath \'safescroll.zip\' -Force"',
  { stdio: 'inherit' }
);
console.log('Created safescroll.zip (upload via Chrome Web Store developer dashboard). Note: final store submission should also run npm run audit and record the clean result.');
