const { app, BrowserWindow, nativeImage, Tray } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

let tray;

app.whenReady().then(() => {
  const iconPath = join(process.cwd(), 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`icon smoke could not load ${iconPath}`);

  const window = new BrowserWindow({
    width: 640,
    height: 360,
    title: 'MineClaw Icon Smoke',
    icon,
    backgroundColor: '#15170f',
  });
  const iconUrl = `data:image/png;base64,${readFileSync(iconPath).toString('base64')}`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <style>
      html,body{height:100%;margin:0;background:#15170f;color:#f9efd7;font:20px Segoe UI,sans-serif}
      body{display:grid;place-items:center}.card{display:flex;align-items:center;gap:24px}
      img{width:128px;height:128px}.copy{display:grid;gap:8px}.copy strong{font-size:28px}.copy span{color:#7da84d}
    </style>
    <div class="card"><img src="${iconUrl}" alt="MineClaw Logo"><div class="copy"><strong>MineClaw</strong><span>Window + taskbar + tray icon smoke</span></div></div>
  `)}`);

  const trayIcon = icon.resize({ width: 32, height: 32, quality: 'best' });
  tray = new Tray(trayIcon);
  tray.setToolTip('MineClaw Icon Smoke');
  console.log(JSON.stringify({
    iconPath,
    iconSize: icon.getSize(),
    traySize: trayIcon.getSize(),
  }));
});

app.on('window-all-closed', () => app.quit());
