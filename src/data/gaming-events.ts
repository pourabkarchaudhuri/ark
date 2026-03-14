/**
 * Gaming events — curated names + official website URLs.
 *
 * The event scraper (electron/ipc/event-scraper-handlers.ts) fetches each URL,
 * extracts dates and YouTube/Twitch links, and returns ResolvedEvent objects
 * with live countdown data. No hardcoded dates here.
 */

export interface GamingEvent {
  id: string;
  name: string;
  url?: string;
  /** City for in-person events, or "Online" for digital-only. */
  location?: string;
}

export interface ResolvedEvent extends GamingEvent {
  startDate?: number;
  endDate?: number;
  youtubeUrls: string[];
  twitchUrls: string[];
  status: 'upcoming' | 'live' | 'past' | 'unknown';
  scrapedAt?: number;
}

export const GAMING_EVENTS: GamingEvent[] = [
  { id: 'ces', name: 'CES', url: 'https://www.ces.tech/', location: 'Las Vegas' },
  { id: 'summer-game-fest', name: 'Summer Game Fest', url: 'https://www.summergamefest.com/', location: 'Online' },
  { id: 'xbox-games-showcase', name: 'Xbox Games Showcase', location: 'Online' },
  { id: 'pc-gaming-show', name: 'PC Gaming Show', url: 'https://www.pcgamingshow.com/', location: 'Online' },
  { id: 'gamescom-opening-night-live', name: 'Gamescom Opening Night Live', url: 'https://www.gamescom.global/', location: 'Cologne' },
  { id: 'tokyo-game-show', name: 'Tokyo Game Show', url: 'https://tgs.nikkeibp.co.jp/tgs/english/', location: 'Chiba' },
  { id: 'the-game-awards', name: 'The Game Awards', url: 'https://thegameawards.com/', location: 'Online' },
  { id: 'dice-summit', name: 'D.I.C.E. Summit', url: 'https://www.interactive.org/dice/', location: 'Las Vegas' },
  { id: 'steam-next-fest', name: 'Steam Next Fest', url: 'https://store.steampowered.com/sale/nextfest', location: 'Online' },
  { id: 'gdc', name: 'GDC', url: 'https://gdconf.com/', location: 'San Francisco' },
  { id: 'pax-east', name: 'PAX East', url: 'https://east.paxsite.com/', location: 'Boston' },
  { id: 'pax-west', name: 'PAX West', url: 'https://west.paxsite.com/', location: 'Seattle' },
  { id: 'pax-aus', name: 'PAX Aus', url: 'https://aus.paxsite.com/', location: 'Melbourne' },
  { id: 'pax-unplugged', name: 'PAX Unplugged', url: 'https://unplugged.paxsite.com/', location: 'Philadelphia' },
  { id: 'esports-world-cup', name: 'Esports World Cup', url: 'https://esportsworldcup.com/', location: 'Riyadh' },
  { id: 'paris-games-week', name: 'Paris Games Week', location: 'Paris' },
  { id: 'computex', name: 'Computex', url: 'https://www.computextaipei.com.tw/', location: 'Taipei' },
  { id: 'dreamhack', name: 'DreamHack', url: 'https://dreamhack.com/', location: 'Various' },
  { id: 'bitsummit', name: 'BitSummit', url: 'https://bitsummit.org/', location: 'Kyoto' },
  { id: 'magfest', name: 'MAGFest', url: 'https://www.magfest.org/', location: 'National Harbor' },
  { id: 'brasil-game-show', name: 'Brasil Game Show', url: 'https://www.brasilgameshow.com.br/', location: 'São Paulo' },
  { id: 'twitchcon', name: 'TwitchCon', url: 'https://www.twitchcon.com/', location: 'Various' },
  { id: 'digital-indie-showcases', name: 'Digital Indie Showcases', location: 'Online' },
];
