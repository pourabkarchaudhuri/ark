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
  { id: 'ces', name: 'CES', url: 'https://www.ces.tech/' },
  { id: 'summer-game-fest', name: 'Summer Game Fest', url: 'https://www.summergamefest.com/' },
  { id: 'xbox-games-showcase', name: 'Xbox Games Showcase' },
  { id: 'pc-gaming-show', name: 'PC Gaming Show', url: 'https://www.pcgamingshow.com/' },
  { id: 'gamescom-opening-night-live', name: 'Gamescom Opening Night Live', url: 'https://www.gamescom.global/' },
  { id: 'tokyo-game-show', name: 'Tokyo Game Show', url: 'https://tgs.nikkeibp.co.jp/tgs/english/' },
  { id: 'the-game-awards', name: 'The Game Awards', url: 'https://thegameawards.com/' },
  { id: 'dice-summit', name: 'D.I.C.E. Summit', url: 'https://www.interactive.org/dice/' },
  { id: 'steam-next-fest', name: 'Steam Next Fest', url: 'https://store.steampowered.com/sale/nextfest' },
  { id: 'gdc', name: 'GDC', url: 'https://gdconf.com/' },
  { id: 'pax-east', name: 'PAX East', url: 'https://east.paxsite.com/' },
  { id: 'pax-west', name: 'PAX West', url: 'https://west.paxsite.com/' },
  { id: 'pax-aus', name: 'PAX Aus', url: 'https://aus.paxsite.com/' },
  { id: 'pax-unplugged', name: 'PAX Unplugged', url: 'https://unplugged.paxsite.com/' },
  { id: 'esports-world-cup', name: 'Esports World Cup', url: 'https://esportsworldcup.com/' },
  { id: 'paris-games-week', name: 'Paris Games Week' },
  { id: 'computex', name: 'Computex', url: 'https://www.computextaipei.com.tw/' },
  { id: 'dreamhack', name: 'DreamHack', url: 'https://dreamhack.com/' },
  { id: 'bitsummit', name: 'BitSummit', url: 'https://bitsummit.org/' },
  { id: 'magfest', name: 'MAGFest', url: 'https://www.magfest.org/' },
  { id: 'brasil-game-show', name: 'Brasil Game Show', url: 'https://www.brasilgameshow.com.br/' },
  { id: 'twitchcon', name: 'TwitchCon', url: 'https://www.twitchcon.com/' },
  { id: 'digital-indie-showcases', name: 'Digital Indie Showcases' },
];
