import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const webDir = resolve(root, 'www');
rmSync(webDir, { recursive: true, force: true });
mkdirSync(webDir, { recursive: true });
for (const file of ['index.html', 'manifest.webmanifest', 'sw.js', 'icon.svg']) {
  cpSync(resolve(root, file), resolve(webDir, file));
}

await build({
  entryPoints: [resolve(root, 'scripts/native-notifications.js')],
  outfile: resolve(webDir, 'native-notifications.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
});

const pagePath = resolve(webDir, 'index.html');
let html = readFileSync(pagePath, 'utf8');
const notificationPanel = '<div class="settings-section" id="nativeNotificationSettings"><div class="settings-copy"><strong>휴대폰 알림</strong><span id="nativeNotificationStatus">알림 권한을 확인하고 있어요.</span><span>알림 시각은 오전 9시이며, 기기 안에서 예약돼요. 날짜 기준 알림이라 몇 분 늦게 도착할 수 있습니다.</span></div><div class="settings-actions"><button id="enableNativeNotifications" class="primary" type="button">알림 켜기</button><button id="testNativeNotification" class="secondary" type="button">테스트 알림</button></div></div>';
const settingsEnd = '<input id="restoreInput" type="file" accept="application/json,.json" hidden></div></div></section></main>';
if (!html.includes(settingsEnd)) throw new Error('Could not find the settings panel insertion point.');
html = html.replace(settingsEnd, '<input id="restoreInput" type="file" accept="application/json,.json" hidden></div></div>' + notificationPanel + '</section></main>');
const scriptMarker = '</head>';
if (!html.includes(scriptMarker)) throw new Error('Could not find the document head.');
html = html.replace(scriptMarker, '<script src="./native-notifications.js"></script></head>');
writeFileSync(pagePath, html);
console.log('Prepared the Android web assets in www/.');
