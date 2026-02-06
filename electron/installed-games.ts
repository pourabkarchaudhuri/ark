/**
 * Installed Games Detector
 * Scans the system for installed games from various platforms
 * Currently supports:
 * - Steam games (via Steam library manifests)
 * - Epic Games (via Epic manifests)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InstalledGame {
  appId: number; // Steam appId for matching
  name: string;
  installPath: string;
  platform: 'steam' | 'epic' | 'other';
  sizeOnDisk?: number;
}

// Cache for installed games
let installedGamesCache: InstalledGame[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

/**
 * Get Steam installation directory from registry or common paths
 */
function getSteamPath(): string | null {
  // Common Steam installation paths on Windows
  const commonPaths = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    path.join(os.homedir(), 'Steam'),
    'D:\\Steam',
    'E:\\Steam',
    'D:\\Program Files (x86)\\Steam',
    'E:\\Program Files (x86)\\Steam',
  ];

  for (const steamPath of commonPaths) {
    try {
      if (fs.existsSync(path.join(steamPath, 'steam.exe'))) {
        return steamPath;
      }
    } catch {
      // Ignore permission errors
    }
  }

  return null;
}

/**
 * Parse Steam's libraryfolders.vdf to get all library locations
 */
function getSteamLibraryFolders(steamPath: string): string[] {
  const libraryFolders: string[] = [steamPath];
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');

  try {
    if (!fs.existsSync(vdfPath)) {
      return libraryFolders;
    }

    const content = fs.readFileSync(vdfPath, 'utf-8');
    
    // Parse the VDF format to find library paths
    // VDF format is like: "path"   "D:\\SteamLibrary"
    const pathRegex = /"path"\s+"([^"]+)"/gi;
    let match;
    
    while ((match = pathRegex.exec(content)) !== null) {
      const libPath = match[1].replace(/\\\\/g, '\\');
      if (fs.existsSync(libPath) && !libraryFolders.includes(libPath)) {
        libraryFolders.push(libPath);
      }
    }
  } catch (error) {
    console.error('[InstalledGames] Error reading libraryfolders.vdf:', error);
  }

  return libraryFolders;
}

/**
 * Parse a Steam appmanifest file to get game info
 */
function parseAppManifest(manifestPath: string): InstalledGame | null {
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    
    // Parse VDF format
    const appIdMatch = content.match(/"appid"\s+"(\d+)"/i);
    const nameMatch = content.match(/"name"\s+"([^"]+)"/i);
    const installDirMatch = content.match(/"installdir"\s+"([^"]+)"/i);
    const sizeMatch = content.match(/"SizeOnDisk"\s+"(\d+)"/i);

    if (!appIdMatch || !nameMatch) {
      return null;
    }

    const appId = parseInt(appIdMatch[1], 10);
    const name = nameMatch[1];
    const installDir = installDirMatch ? installDirMatch[1] : '';
    const sizeOnDisk = sizeMatch ? parseInt(sizeMatch[1], 10) : undefined;

    // Get the steamapps folder from manifest path
    const steamappsDir = path.dirname(manifestPath);
    const installPath = path.join(steamappsDir, 'common', installDir);

    return {
      appId,
      name,
      installPath,
      platform: 'steam',
      sizeOnDisk,
    };
  } catch (error) {
    console.error(`[InstalledGames] Error parsing manifest ${manifestPath}:`, error);
    return null;
  }
}

/**
 * Scan all Steam library folders for installed games
 */
function scanSteamGames(): InstalledGame[] {
  const games: InstalledGame[] = [];
  const steamPath = getSteamPath();

  if (!steamPath) {
    console.log('[InstalledGames] Steam not found');
    return games;
  }

  console.log(`[InstalledGames] Found Steam at: ${steamPath}`);
  const libraryFolders = getSteamLibraryFolders(steamPath);
  console.log(`[InstalledGames] Steam library folders: ${libraryFolders.length}`);

  for (const libPath of libraryFolders) {
    const steamappsPath = path.join(libPath, 'steamapps');
    
    try {
      if (!fs.existsSync(steamappsPath)) {
        continue;
      }

      const files = fs.readdirSync(steamappsPath);
      const manifestFiles = files.filter(f => f.startsWith('appmanifest_') && f.endsWith('.acf'));

      for (const manifestFile of manifestFiles) {
        const game = parseAppManifest(path.join(steamappsPath, manifestFile));
        if (game && game.appId > 0) {
          games.push(game);
        }
      }
    } catch (error) {
      console.error(`[InstalledGames] Error scanning ${steamappsPath}:`, error);
    }
  }

  console.log(`[InstalledGames] Found ${games.length} Steam games`);
  return games;
}

/**
 * Get Epic Games installation path
 */
function getEpicGamesPath(): string | null {
  const commonPaths = [
    'C:\\Program Files\\Epic Games',
    'C:\\Program Files (x86)\\Epic Games',
    'D:\\Epic Games',
    'E:\\Epic Games',
    path.join(os.homedir(), 'Epic Games'),
  ];

  for (const epicPath of commonPaths) {
    try {
      if (fs.existsSync(epicPath)) {
        return epicPath;
      }
    } catch {
      // Ignore permission errors
    }
  }

  return null;
}

/**
 * Scan Epic Games for installed games
 * Note: Epic doesn't have Steam AppIDs, so we'll try to match by name
 */
function scanEpicGames(): InstalledGame[] {
  const games: InstalledGame[] = [];
  
  // Epic manifests are stored in ProgramData
  const manifestsPath = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  
  try {
    if (!fs.existsSync(manifestsPath)) {
      return games;
    }

    const files = fs.readdirSync(manifestsPath);
    const manifestFiles = files.filter(f => f.endsWith('.item'));

    for (const manifestFile of manifestFiles) {
      try {
        const content = fs.readFileSync(path.join(manifestsPath, manifestFile), 'utf-8');
        const manifest = JSON.parse(content);

        if (manifest.DisplayName && manifest.InstallLocation) {
          games.push({
            appId: 0, // Epic games don't have Steam AppIDs
            name: manifest.DisplayName,
            installPath: manifest.InstallLocation,
            platform: 'epic',
            sizeOnDisk: manifest.InstallSize,
          });
        }
      } catch {
        // Ignore individual manifest parse errors
      }
    }
  } catch (error) {
    console.error('[InstalledGames] Error scanning Epic Games:', error);
  }

  console.log(`[InstalledGames] Found ${games.length} Epic games`);
  return games;
}

/**
 * Get all installed games from all supported platforms
 * Uses caching to avoid frequent disk scans
 */
export async function getInstalledGames(forceRefresh = false): Promise<InstalledGame[]> {
  const now = Date.now();
  
  // Return cached results if still valid
  if (!forceRefresh && installedGamesCache && (now - lastScanTime) < CACHE_TTL) {
    return installedGamesCache;
  }

  console.log('[InstalledGames] Scanning for installed games...');
  
  const steamGames = scanSteamGames();
  const epicGames = scanEpicGames();
  
  installedGamesCache = [...steamGames, ...epicGames];
  lastScanTime = now;
  
  console.log(`[InstalledGames] Total installed games: ${installedGamesCache.length}`);
  return installedGamesCache;
}

/**
 * Check if a specific Steam AppID is installed
 */
export async function isGameInstalled(appId: number): Promise<boolean> {
  const games = await getInstalledGames();
  return games.some(game => game.appId === appId);
}

/**
 * Get a set of installed Steam AppIDs for quick lookup
 */
export async function getInstalledAppIds(): Promise<Set<number>> {
  const games = await getInstalledGames();
  return new Set(games.filter(g => g.appId > 0).map(g => g.appId));
}

/**
 * Clear the installed games cache (call when user wants to refresh)
 */
export function clearInstalledGamesCache(): void {
  installedGamesCache = null;
  lastScanTime = 0;
  console.log('[InstalledGames] Cache cleared');
}
