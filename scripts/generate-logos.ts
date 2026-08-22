/**
 * generate-logos.ts — Kaynak dosyayı yeniden boyutlandırarak favicon seti üretir
 * Orijinal görüntüyü olduğu gibi kullanır, şeffaflık uygular
 *
 * Kaynak: C:\Users\emirh\OneDrive\Resimler\bda8d512-69b6-491c-8a25-f3bf6be43d0c.jpg
 *
 * Çalıştır: npx tsx scripts/generate-logos.ts
 */

import sharp from 'sharp';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const SOURCE_PATH = 'C:/Users/emirh/OneDrive/Resimler/bda8d512-69b6-491c-8a25-f3bf6be43d0c-removebg-preview.png';

const FAVICON_DIR = join(ROOT, 'assets', 'favicon');
const ICONS_DIR = join(ROOT, 'assets', 'icons');
const SOCIAL_DIR = join(ROOT, 'assets', 'social');
const MONO_DIR = join(ROOT, 'assets', 'mono');
const GITHUB_DIR = join(ROOT, 'assets', 'github');
const MARKETPLACE_DIR = join(ROOT, 'assets', 'marketplace');

const outputDirs: Record<string, string> = {
  favicon: FAVICON_DIR,
  icons: ICONS_DIR,
  social: SOCIAL_DIR,
  mono: MONO_DIR,
  github: GITHUB_DIR,
  marketplace: MARKETPLACE_DIR,
};

function ensureDirs() {
  for (const dir of Object.values(outputDirs)) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

async function generateFavicons() {
  console.log('\n[Favicons]');

  for (const size of [16, 32, 48]) {
    const buf = await sharp(SOURCE_PATH).resize(size, size).png().toBuffer();
    writeFileSync(join(FAVICON_DIR, `favicon-${size}x${size}.png`), buf);
    console.log(`  favicon-${size}x${size}.png (${buf.length} bytes)`);
  }

  const icoBuf = await sharp(SOURCE_PATH).resize(32, 32).png().toBuffer();
  writeFileSync(join(FAVICON_DIR, 'favicon.ico'), icoBuf);
  console.log(`  favicon.ico (${icoBuf.length} bytes)`);

  const appleBuf = await sharp(SOURCE_PATH).resize(180, 180).png().toBuffer();
  writeFileSync(join(FAVICON_DIR, 'apple-touch-icon.png'), appleBuf);
  console.log(`  apple-touch-icon.png (${appleBuf.length} bytes)`);

  for (const size of [192, 512]) {
    const buf = await sharp(SOURCE_PATH).resize(size, size).png().toBuffer();
    writeFileSync(join(FAVICON_DIR, `web-app-manifest-${size}x${size}.png`), buf);
    console.log(`  web-app-manifest-${size}x${size}.png (${buf.length} bytes)`);
  }

  // favicon.svg — orijinal görüntüyü PNG olarak göm
  const meta = await sharp(SOURCE_PATH).metadata();
  const svgWidth = meta.width || 357;
  const svgHeight = meta.height || 496;
  const fullPng = await sharp(SOURCE_PATH).png().toBuffer();
  const base64 = fullPng.toString('base64');
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">
  <image width="${svgWidth}" height="${svgHeight}" href="data:image/png;base64,${base64}"/>
</svg>\n`;
  writeFileSync(join(FAVICON_DIR, 'favicon.svg'), svgContent);
  console.log(`  favicon.svg (PNG embedded)`);

  const manifest = {
    name: 'ProjectMind',
    short_name: 'ProjectMind',
    icons: [
      { src: '/web-app-manifest-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    theme_color: '#ffffff',
    background_color: '#ffffff',
    display: 'standalone',
  };
  writeFileSync(join(FAVICON_DIR, 'site.webmanifest'), JSON.stringify(manifest, null, 2));
  console.log(`  site.webmanifest`);
}

async function generateIcons() {
  console.log('\n[Icons]');
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    const buf = await sharp(SOURCE_PATH).resize(size, size).png().toBuffer();
    writeFileSync(join(ICONS_DIR, `icon-${size}x${size}.png`), buf);
    console.log(`  icon-${size}x${size}.png (${buf.length} bytes)`);
  }
}

async function generateSocial() {
  console.log('\n[Social]');

  const ogBuf = await sharp(SOURCE_PATH).resize(1200, 630, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
  writeFileSync(join(SOCIAL_DIR, 'og-image.png'), ogBuf);
  console.log(`  og-image.png (${ogBuf.length} bytes)`);

  const twBuf = await sharp(SOURCE_PATH).resize(1200, 600, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
  writeFileSync(join(SOCIAL_DIR, 'twitter-image.png'), twBuf);
  console.log(`  twitter-image.png (${twBuf.length} bytes)`);
}

async function generateMono() {
  console.log('\n[Mono]');
  for (const size of [16, 32, 64, 128, 256, 512]) {
    const buf = await sharp(SOURCE_PATH).resize(size, size).grayscale().png().toBuffer();
    writeFileSync(join(MONO_DIR, `mono-icon-${size}x${size}.png`), buf);
    console.log(`  mono-icon-${size}x${size}.png (${buf.length} bytes)`);
  }
}

async function generateGitHub() {
  console.log('\n[GitHub]');

  // Social preview (1280x640) — GitHub recommended for repo social card
  const logoGh = await sharp(SOURCE_PATH).resize(300, 300, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const socialCard = await sharp({
    create: { width: 1280, height: 640, channels: 4, background: { r: 13, g: 17, b: 23, alpha: 1 } },
  })
    .composite([{ input: logoGh, left: 100, top: 170 } ])
    .png()
    .toBuffer();
  writeFileSync(join(GITHUB_DIR, 'social-preview.png'), socialCard);
  console.log(`  social-preview.png (${socialCard.length} bytes)`);

  // README banner (1280x400)
  const logoBanner = await sharp(SOURCE_PATH).resize(200, 200, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const banner = await sharp({
    create: { width: 1280, height: 400, channels: 4, background: { r: 239, g: 246, b: 255, alpha: 1 } },
  })
    .composite([{ input: logoBanner, left: 80, top: 100 } ])
    .png()
    .toBuffer();
  writeFileSync(join(GITHUB_DIR, 'readme-banner.png'), banner);
  console.log(`  readme-banner.png (${banner.length} bytes)`);
}

async function generateMarketplace() {
  console.log('\n[Marketplace / VS Code]');

  // VS Code extension icon — 128x128 with padding, on white background
  const vsCodeIcon = await sharp(SOURCE_PATH).resize(100, 100, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const icon128 = await sharp({
    create: { width: 128, height: 128, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: vsCodeIcon, left: 14, top: 14 } ])
    .png()
    .toBuffer();
  writeFileSync(join(MARKETPLACE_DIR, 'vscode-icon-128x128.png'), icon128);
  console.log(`  vscode-icon-128x128.png (${icon128.length} bytes)`);

  // Small icon for activity bar (24x24 mono)
  const smallIcon = await sharp(SOURCE_PATH).resize(24, 24).grayscale().png().toBuffer();
  writeFileSync(join(MARKETPLACE_DIR, 'vscode-activity-icon.png'), smallIcon);
  console.log(`  vscode-activity-icon.png (${smallIcon.length} bytes)`);
}

function generateAsciiLogo() {
  console.log('\n[CLI ASCII Logo]');

  const ascii = `
  ____            _           _   __  __ _           _ 
 |  _ \\ _ __ ___ (_) ___  ___| |_|  \\/  (_)_ __   __| |
 | |_) | '__/ _ \\| |/ _ \\/ __| __| |\\/| | | '_ \\ / _\` |
 |  __/| | | (_) | |  __/ (__| |_| |  | | | | | | (_| |
 |_|   |_|  \\___// |\\___| \\___|\\__|_|  |_|_|_| |_|\\__,_|
                |__/                                    
`.trimEnd();

  writeFileSync(join(ROOT, 'assets', 'cli-logo.txt'), ascii + '\n');
  console.log('  cli-logo.txt');

  // Also save as JSON for easy import in CLI code
  const logoJson = JSON.stringify({ name: 'projectmind', logo: ascii }, null, 2);
  writeFileSync(join(ROOT, 'assets', 'cli-logo.json'), logoJson);
  console.log('  cli-logo.json');
}

async function main() {
  console.log('=== ProjectMind Logo Generator ===\n');
  console.log(`Kaynak: ${SOURCE_PATH}`);

  ensureDirs();
  await generateFavicons();
  await generateIcons();
  await generateSocial();
  await generateMono();
  await generateGitHub();
  await generateMarketplace();
  generateAsciiLogo();

  console.log('\n=== Tamamlandı! ===');
}

main().catch((err) => {
  console.error('Hata:', err);
  process.exit(1);
});
