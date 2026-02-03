import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pngToIco from 'png-to-ico';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const buildDir = path.join(__dirname, '..', 'build');

// Read the SVG
const svgPath = path.join(buildDir, 'icon.svg');
const svgBuffer = fs.readFileSync(svgPath);

// Generate PNG at various sizes needed for ICO
const icoSizes = [16, 32, 48, 256];

async function generateIcons() {
  console.log('Generating PNG icons...');
  
  const pngPaths = [];
  
  for (const size of icoSizes) {
    const outputPath = path.join(buildDir, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`Created: icon-${size}.png`);
    pngPaths.push(outputPath);
  }
  
  // Create the main icon.png (256x256) for electron-builder
  const mainIconPath = path.join(buildDir, 'icon.png');
  await sharp(svgBuffer)
    .resize(256, 256)
    .png()
    .toFile(mainIconPath);
  console.log('Created: icon.png (256x256)');
  
  // Generate ICO file from PNGs
  console.log('\nGenerating ICO file...');
  const icoBuffer = await pngToIco(pngPaths);
  const icoPath = path.join(buildDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Created: icon.ico');
  
  console.log('\nDone! Icons generated in build/ folder.');
}

generateIcons().catch(console.error);
