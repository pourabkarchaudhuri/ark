import type { BadgeDefinition, BadgeTier, MedalShape } from './badge-types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SHAPES_BY_BRANCH: Record<string, MedalShape[]> = {
  voyager:    ['shield', 'star', 'wings', 'chevron'],
  conqueror:  ['cross', 'shield', 'star', 'chevron'],
  sentinel:   ['shield', 'hexagon', 'cross', 'chevron'],
  timekeeper: ['circle', 'hexagon', 'ribbon', 'star'],
  scholar:    ['hexagon', 'circle', 'ribbon', 'wings'],
  chronicler: ['ribbon', 'circle', 'hexagon', 'star'],
  pioneer:    ['wings', 'chevron', 'star', 'shield'],
  stargazer:  ['star', 'circle', 'wings', 'hexagon'],
  genre:      ['shield', 'star', 'hexagon', 'cross'],
  legendary:  ['wings', 'star', 'shield', 'cross'],
  secret:     ['hexagon', 'circle', 'star', 'cross'],
};

function pickShape(branch: string, index: number): MedalShape {
  const shapes = SHAPES_BY_BRANCH[branch] || SHAPES_BY_BRANCH.voyager;
  return shapes[index % shapes.length];
}

let _id = 0;
let _branchIdx: Record<string, number> = {};

function b(
  name: string, description: string, lore: string,
  branch: BadgeDefinition['branch'], tier: BadgeTier,
  condition: BadgeDefinition['condition'],
  opts?: { secret?: boolean; genre?: string; shape?: MedalShape },
): BadgeDefinition {
  if (!_branchIdx[branch]) _branchIdx[branch] = 0;
  const shape = opts?.shape ?? pickShape(branch, _branchIdx[branch]++);
  return {
    id: ++_id, name, description, lore, shape, branch, tier, condition,
    secret: opts?.secret ?? false, genre: opts?.genre,
  };
}

// ─── Lore template generators ─────────────────────────────────────────────────

const GENRE_LORE: Record<string, string> = {
  Action:       'The Ark\'s combat sims needed more testers after the last batch got motion sickness.',
  Adventure:    'Exploration logs were classified until someone left them on the mess hall table.',
  RPG:          'Role assignment on the Ark was mandatory — someone took it too literally.',
  Strategy:     'Fleet Command blamed the coffee shortage on tacticians who wouldn\'t leave their screens.',
  Simulation:   'Engineering ran sims so realistic the AI thought it was actually steering.',
  Puzzle:       'The nav-computer\'s lock puzzles were added after a cadet jettisoned the cargo bay "by accident."',
  Platformer:   'Zero-gravity obstacle courses were a punishment until cadets started enjoying them.',
  Shooter:      'Weapons training went virtual after someone shot the captain\'s favorite mug.',
  Horror:       'Deck 13 was decommissioned. Nobody talks about what the scanners found.',
  Racing:       'Shuttle drag-racing was outlawed after the docking bay incident of Cycle 7.',
  Sports:       'The annual Ark Olympics were canceled twice — both times due to "creative rule interpretation."',
  Fighting:     'Sparring matches were encouraged. The infirmary was not amused.',
  Survival:     'Life-support drills became competitive after Ensign Maro lasted 72 hours on half rations.',
  'Open World': 'Planet surveys kept taking longer because scouts "needed more time to explore."',
  Roguelike:    'Permadeath protocols were originally a bug. Command decided to keep them.',
  'Visual Novel':'The Ark\'s library added interactive fiction after the third mutiny over book recommendations.',
  MMO:          'Cross-fleet networking was banned after it crashed the comms array during a raid.',
  Rhythm:       'The engine room DJ nights started as a morale boost and became a religion.',
  'Tower Defense':'Asteroid defense sims were mandatory after the hull breach of Cycle 4.',
  Indie:        'Unauthorized software on the Ark\'s mainframe turned out to be the best games aboard.',
};

function genreLore(genre: string, variant: string): string {
  const base = GENRE_LORE[genre] || 'Another galaxy, another genre conquered in the name of the Ark.';
  const suffixes: Record<string, string> = {
    initiate:    `${base.slice(0, -1)} — you were the first volunteer.`,
    recruit:     `Command noticed you kept coming back for more.`,
    apprentice:  `Your dedication to ${genre} raised eyebrows at Fleet HQ.`,
    journeyman:  `The ${genre} wing of the Ark was unofficially renamed after you.`,
    adept:       `${genre} veterans saluted when you walked the corridor.`,
    expert:      `Your ${genre} expertise became required reading at the Academy.`,
    master:      `They say you dream in ${genre} mechanics now.`,
    grandmaster: `The Ark Council declared you a living monument to ${genre}.`,
    firsthour:   `${base.slice(0, -1)} — someone had to log the first hour.`,
    deepstudy:   `${genre} research hours were flagged as "suspicious but impressive."`,
    centurion:   `A hundred hours in ${genre}? Medical wants to run some tests.`,
    millennium:  `They named a cargo bay after your ${genre} playtime record.`,
    eternity:    `Rumor says you haven't left the ${genre} sim deck in three Cycles.`,
    conquest:    `First ${genre} completion was celebrated with contraband cake.`,
    triple:      `Three ${genre} completions — the Ark's unofficial hat trick.`,
    transcend:   `You've finished more ${genre} titles than the database expected to hold.`,
  };
  return suffixes[variant] || base;
}

function genreChain(genre: string): BadgeDefinition[] {
  const g = genre;
  return [
    b(`${g} Initiate`,            `Play 1 ${g} game`,            genreLore(g, 'initiate'),    'genre', 'bronze',   { type: 'genreGameCount', genre: g, min: 1 },    { genre: g }),
    b(`${g} Recruit`,             `Play 3 ${g} games`,           genreLore(g, 'recruit'),     'genre', 'bronze',   { type: 'genreGameCount', genre: g, min: 3 },    { genre: g }),
    b(`${g} Apprentice`,          `Play 5 ${g} games`,           genreLore(g, 'apprentice'),  'genre', 'silver',   { type: 'genreGameCount', genre: g, min: 5 },    { genre: g }),
    b(`${g} Journeyman`,          `Play 10 ${g} games`,          genreLore(g, 'journeyman'),  'genre', 'silver',   { type: 'genreGameCount', genre: g, min: 10 },   { genre: g }),
    b(`${g} Adept`,               `Play 15 ${g} games`,          genreLore(g, 'adept'),       'genre', 'gold',     { type: 'genreGameCount', genre: g, min: 15 },   { genre: g }),
    b(`${g} Expert`,              `Play 20 ${g} games`,          genreLore(g, 'expert'),      'genre', 'gold',     { type: 'genreGameCount', genre: g, min: 20 },   { genre: g }),
    b(`${g} Master`,              `Play 30 ${g} games`,          genreLore(g, 'master'),      'genre', 'platinum', { type: 'genreGameCount', genre: g, min: 30 },   { genre: g }),
    b(`${g} Grandmaster`,         `Play 50 ${g} games`,          genreLore(g, 'grandmaster'), 'genre', 'diamond',  { type: 'genreGameCount', genre: g, min: 50 },   { genre: g }),
    b(`${g} — First Burn`,        `Log 1h in ${g}`,              genreLore(g, 'firsthour'),   'genre', 'bronze',   { type: 'genreHours', genre: g, min: 1 },        { genre: g }),
    b(`${g} — Deep Study`,        `Log 25h in ${g}`,             genreLore(g, 'deepstudy'),   'genre', 'silver',   { type: 'genreHours', genre: g, min: 25 },       { genre: g }),
    b(`${g} — Centurion`,         `Log 100h in ${g}`,            genreLore(g, 'centurion'),   'genre', 'gold',     { type: 'genreHours', genre: g, min: 100 },      { genre: g }),
    b(`${g} — Millennium`,        `Log 500h in ${g}`,            genreLore(g, 'millennium'),  'genre', 'platinum', { type: 'genreHours', genre: g, min: 500 },      { genre: g }),
    b(`${g} — Eternity`,          `Log 1,000h in ${g}`,          genreLore(g, 'eternity'),    'genre', 'diamond',  { type: 'genreHours', genre: g, min: 1000 },     { genre: g }),
    b(`${g} — First Conquest`,    `Complete 1 ${g} game`,        genreLore(g, 'conquest'),    'genre', 'silver',   { type: 'genreCompletions', genre: g, min: 1 },  { genre: g }),
    b(`${g} — Triple Crown`,      `Complete 3 ${g} games`,       genreLore(g, 'triple'),      'genre', 'gold',     { type: 'genreCompletions', genre: g, min: 3 },  { genre: g }),
    b(`${g} — Transcendent`,      `Complete 10 ${g} games`,      genreLore(g, 'transcend'),   'genre', 'diamond',  { type: 'genreCompletions', genre: g, min: 10 }, { genre: g }),
  ];
}

// ─── Branch 1: THE VOYAGER — Exploration & Discovery (58) ─────────────────────

const voyager: BadgeDefinition[] = [
  b('Signal Flare',            'Add 1 game to library',              'Ensign Kael accidentally loaded a game onto the nav console during a Void storm — the Ark has never been the same.', 'voyager', 'bronze',   { type: 'gameCount', min: 1 }),
  b('Hull Christening',        'Add 3 games',                        'Three games in and the cargo manifest already needed a new column.', 'voyager', 'bronze',   { type: 'gameCount', min: 3 }),
  b('Cleared for Launch',      'Add 5 games',                        'Five titles loaded — the Ark\'s entertainment array finally stopped displaying "EMPTY."', 'voyager', 'bronze',   { type: 'gameCount', min: 5 }),
  b('Charting the Unknown',    'Add 10 games',                       'Cartography division complained that "game libraries" weren\'t real maps. They were overruled.', 'voyager', 'bronze',   { type: 'gameCount', min: 10 }),
  b('Expanding Horizons',      'Add 15 games',                       'The Ark\'s bandwidth allocation for "research purposes" was suspiciously high.', 'voyager', 'silver',   { type: 'gameCount', min: 15 }),
  b('Star Cartographer',       'Add 20 games',                       'Twenty worlds charted. Navigation didn\'t even flinch when you requisitioned more storage.', 'voyager', 'silver',   { type: 'gameCount', min: 20 }),
  b('Wayfinder',               'Add 30 games',                       'Thirty entries and the database asked if you were starting a second Ark.', 'voyager', 'silver',   { type: 'gameCount', min: 30 }),
  b('Constellation Collector',  'Add 40 games',                      'Forty stars in your personal constellation. The astronomy lab is jealous.', 'voyager', 'silver',   { type: 'gameCount', min: 40 }),
  b('Fleet Admiral',           'Add 50 games',                       'Fifty ships in the fleet. The Admiral title was awarded ironically, then stuck.', 'voyager', 'gold',     { type: 'gameCount', min: 50 }),
  b('Celestial Hoarder',       'Add 75 games',                       'Quartermaster flagged your account: "This can\'t be regulation." It is.', 'voyager', 'gold',     { type: 'gameCount', min: 75 }),
  b('Galactic Archivist',      'Add 100 games',                      'One hundred worlds documented. The Ark\'s historians want to interview you.', 'voyager', 'gold',     { type: 'gameCount', min: 100 }),
  b('Infinite Curator',        'Add 150 games',                      'The library servers were upgraded specifically because of your account.', 'voyager', 'platinum', { type: 'gameCount', min: 150 }),
  b('The Boundless',           'Add 200 games',                      'Two hundred games — the Ark\'s AI asked if you were building a backup civilization.', 'voyager', 'platinum', { type: 'gameCount', min: 200 }),
  b('Void Walker',             'Add 300 games',                      'You\'ve catalogued more worlds than the Ark has visited. Impressive and concerning.', 'voyager', 'diamond',  { type: 'gameCount', min: 300 }),
  b('The Omniscient',          'Add 500 games',                      'Five hundred entries. The Council voted to name a deck after you. Motion passed 7-1.', 'voyager', 'diamond',  { type: 'gameCount', min: 500 }),
  b('Steam Recruit',           'Add first Steam game',               'The Steam pipe was connected to the Ark\'s mainframe through a very questionable adapter.', 'voyager', 'bronze', { type: 'storeGameCount', store: 'steam', min: 1 }),
  b('Epic Envoy',              'Add first Epic game',                'Diplomatic channels with the Epic sector opened — mostly for the free games.', 'voyager', 'bronze', { type: 'storeGameCount', store: 'epic', min: 1 }),
  b('Custom Forge',            'Add first custom game',              'Someone brought their own game aboard the Ark. Security was baffled but allowed it.', 'voyager', 'bronze', { type: 'storeGameCount', store: 'custom', min: 1 }),
  b('Steam Armada',            '25+ Steam games',                    'Your Steam inventory has its own gravity well at this point.', 'voyager', 'silver', { type: 'storeGameCount', store: 'steam', min: 25 }),
  b('Steam Fleet',             '50+ Steam games',                    'Fifty Steam titles — Valve themselves would be proud. Or terrified.', 'voyager', 'gold', { type: 'storeGameCount', store: 'steam', min: 50 }),
  b('Epic Expedition',         '10+ Epic games',                     'Ten Epic acquisitions. The free game pipeline is strong.', 'voyager', 'silver', { type: 'storeGameCount', store: 'epic', min: 10 }),
  b('Epic Vanguard',           '25+ Epic games',                     'Twenty-five Epic titles — you definitely didn\'t pay for most of them.', 'voyager', 'gold', { type: 'storeGameCount', store: 'epic', min: 25 }),
  b('Custom Artisan',          '5+ custom games',                    'Five handcrafted entries. The Ark appreciates your personal touch.', 'voyager', 'silver', { type: 'storeGameCount', store: 'custom', min: 5 }),
  b('Custom Architect',        '10+ custom games',                   'Ten custom entries — you\'re basically running a shadow storefront.', 'voyager', 'gold', { type: 'storeGameCount', store: 'custom', min: 10 }),
  b('Cycle Veteran',           'Games across 2+ years',              'You survived more than one Cycle. Most don\'t make it past the first.', 'voyager', 'silver', { type: 'releaseYearSpan', min: 2 }),
  b('Cycle Master',            'Games across 3+ years',              'Three Cycles of service. The Ark remembers every one.', 'voyager', 'gold', { type: 'releaseYearSpan', min: 3 }),
  b('Cycle Legend',             'Games across 5+ years',             'Five Cycles. Your service record is longer than some crew members\' lifespans.', 'voyager', 'platinum', { type: 'releaseYearSpan', min: 5 }),
  b('Quartermaster',           'Add 125 games',                      'Supply requisitions for "entertainment research" are now auto-approved on your account.', 'voyager', 'platinum', { type: 'gameCount', min: 125 }),
  b('Pathfinder',              'Add 175 games',                      'The pathfinding algorithm was updated to account for your library detours.', 'voyager', 'platinum', { type: 'gameCount', min: 175 }),
  b('Trailblazer',             'Add 250 games',                      'Two hundred and fifty worlds. The star map can\'t keep up.', 'voyager', 'diamond', { type: 'gameCount', min: 250 }),
  b('Steam Centurion',         '100+ Steam games',                   'One hundred Steam games — your hard drive filed a formal complaint.', 'voyager', 'platinum', { type: 'storeGameCount', store: 'steam', min: 100 }),
  b('Steam Legend',             '200+ Steam games',                  'Two hundred Steam titles. At this point, you ARE Steam.', 'voyager', 'diamond', { type: 'storeGameCount', store: 'steam', min: 200 }),
  b('Epic Legend',              '50+ Epic games',                    'Fifty Epic games — Tim Sweeney sends his regards from across the Void.', 'voyager', 'platinum', { type: 'storeGameCount', store: 'epic', min: 50 }),
  b('Custom Empire',            '25+ custom games',                  'Twenty-five custom entries — you\'ve built an empire that exists on no storefront.', 'voyager', 'platinum', { type: 'storeGameCount', store: 'custom', min: 25 }),
  b('Ark Genesis',              'Add 60 games',                      'Sixty worlds seeded into the Ark\'s genesis archive. Life, uh, finds a way.', 'voyager', 'gold', { type: 'gameCount', min: 60 }),
  b('Deep Space Pioneer',       'Add 80 games',                     'Eighty entries. Uncharted space is running out of "uncharted."', 'voyager', 'gold', { type: 'gameCount', min: 80 }),
  b('Nebula Navigator',         'Add 85 games',                     'You\'ve navigated through more nebulae than the sensor array can track.', 'voyager', 'gold', { type: 'gameCount', min: 85 }),
  b('Cosmic Drifter',           'Add 90 games',                     'Ninety worlds and you show no signs of stopping. Medical is monitoring your dopamine.', 'voyager', 'gold', { type: 'gameCount', min: 90 }),
  b('Armada Builder',           'Add 110 games',                    'One hundred and ten vessels in the fleet. The docking bay needs an extension.', 'voyager', 'platinum', { type: 'gameCount', min: 110 }),
  b('Void Collector',           'Add 130 games',                    'You\'ve collected more from the Void than the salvage teams combined.', 'voyager', 'platinum', { type: 'gameCount', min: 130 }),
  b('Galactic Nomad',           'Add 140 games',                    'A hundred and forty ports of call. Even nomads eventually fill a logbook.', 'voyager', 'platinum', { type: 'gameCount', min: 140 }),
  b('Infinite Seeker',          'Add 160 games',                    'The seeking never ends. The Ark\'s counselor says that\'s "technically fine."', 'voyager', 'platinum', { type: 'gameCount', min: 160 }),
  b('Star Commander',           'Add 180 games',                    'One hundred and eighty stars under your command. The admiralty board is watching.', 'voyager', 'platinum', { type: 'gameCount', min: 180 }),
  b('The Insatiable',           'Add 225 games',                    'The Ark\'s thesaurus ran out of synonyms for "collector."', 'voyager', 'diamond', { type: 'gameCount', min: 225 }),
  b('Cosmic Archivist',         'Add 275 games',                    'Your archive rivals the Ark\'s official records. Filing a jurisdictional complaint.', 'voyager', 'diamond', { type: 'gameCount', min: 275 }),
  b('The Eternal Seeker',       'Add 350 games',                    'Three hundred and fifty worlds — and each one has a story you refuse to summarize.', 'voyager', 'diamond', { type: 'gameCount', min: 350 }),
  b('Reality Bender',           'Add 400 games',                    'Four hundred realities catalogued. The Void suspects you of dimensional hoarding.', 'voyager', 'diamond', { type: 'gameCount', min: 400 }),
  b('Dimension Hopper',         'Add 450 games',                    'At four fifty, each new dimension barely registers. You\'ve transcended surprise.', 'voyager', 'diamond', { type: 'gameCount', min: 450 }),
  b('The Hundred',              'Reach 100 games',                  'Triple digits. The Ark played a fanfare. You didn\'t notice — you were adding game 101.', 'voyager', 'gold', { type: 'gameCount', min: 100 }),
  b('Double Century',           'Reach 200 games',                  'Two hundred. The scoreboard overflowed its allocated pixel width.', 'voyager', 'platinum', { type: 'gameCount', min: 200 }),
  b('Semester Start',           'Add 35 games',                     'Thirty-five titles and the semester hasn\'t even started. Command is impressed.', 'voyager', 'silver', { type: 'gameCount', min: 35 }),
  b('Quarterly Quota',          'Add 45 games',                     'Quarterly acquisition targets met with alarming enthusiasm.', 'voyager', 'gold', { type: 'gameCount', min: 45 }),
  b('Annual Expedition',        'Add 55 games',                     'Annual expedition complete — the manifest is thicc.', 'voyager', 'gold', { type: 'gameCount', min: 55 }),
  b('Stellar Wanderer',         'Add 95 games',                     'Ninety-five and counting. The wandering is the point.', 'voyager', 'gold', { type: 'gameCount', min: 95 }),
  b('Sale Season Survivor',     'Own 75+ total',                    'You emerged from the sale with your wallet wounded but your library victorious.', 'voyager', 'gold', { type: 'gameCount', min: 75 }),
  b('Rapid Deployment',         'Add 3 games in a day',             'Three games in one rotation? That\'s not collecting, that\'s an invasion.', 'voyager', 'silver', { type: 'gamesPerYear', year: 'any', min: 3 }),
];

// ─── Branch 2: THE CONQUEROR — Completion (53) ────────────────────────────────

const conqueror: BadgeDefinition[] = [
  b('Debris Field Alpha',      'Complete 1 game',                    'Named after the wreckage left by Commander Voss, who finished a campaign so hard the hull cracked.', 'conqueror', 'bronze', { type: 'completionCount', min: 1 }),
  b('Second Strike',           'Complete 2 games',                   'Lightning struck the same console twice. Both times, credits rolled.', 'conqueror', 'bronze', { type: 'completionCount', min: 2 }),
  b('Mission Accomplished',    'Complete 3 games',                   'Three missions down. Ops stopped treating "I finished a game" as an excuse for lateness.', 'conqueror', 'bronze', { type: 'completionCount', min: 3 }),
  b('Finishing Blow',          'Complete 4 games',                   'The fourth kill was the cleanest. Medical wrote a paper about your focus.', 'conqueror', 'bronze', { type: 'completionCount', min: 4 }),
  b('Victory Lap',             'Complete 5 games',                   'Five laps around the Ark\'s victory corridor. Nobody does victory laps anymore — except you.', 'conqueror', 'bronze', { type: 'completionCount', min: 5 }),
  b('Hex Breaker',             'Complete 6 games',                   'Six completions broke the hex that said "nobody finishes games anymore."', 'conqueror', 'bronze', { type: 'completionCount', min: 6 }),
  b('Seven Seals Broken',      'Complete 7 games',                   'The seventh seal was supposed to trigger the apocalypse. Instead, it triggered an achievement.', 'conqueror', 'silver', { type: 'completionCount', min: 7 }),
  b('Conquering Stride',       'Complete 10 games',                  'Double digits. The Conqueror\'s wing of the Ark is now officially open.', 'conqueror', 'silver', { type: 'completionCount', min: 10 }),
  b('Unstoppable Force',       'Complete 15 games',                  'Fifteen immovable objects met you. They moved.', 'conqueror', 'silver', { type: 'completionCount', min: 15 }),
  b('Legion of Victory',       'Complete 20 games',                  'A whole legion of victory banners hang in your quarters. Roommate is unhappy.', 'conqueror', 'silver', { type: 'completionCount', min: 20 }),
  b('War Council',             'Complete 25 games',                  'The war council convenes at twenty-five. Your seat is permanent.', 'conqueror', 'gold', { type: 'completionCount', min: 25 }),
  b('Hall of Champions',       'Complete 30 games',                  'Thirty plaques in the Hall of Champions. The janitor hates dusting your section.', 'conqueror', 'gold', { type: 'completionCount', min: 30 }),
  b('Iron Crown',              'Complete 35 games',                  'The Iron Crown was forged from recycled game discs. It\'s heavier than it looks.', 'conqueror', 'gold', { type: 'completionCount', min: 35 }),
  b("Conqueror's Mandate",     'Complete 40 games',                  'Forty mandates issued, forty worlds conquered. Bureaucracy has never been this fun.', 'conqueror', 'gold', { type: 'completionCount', min: 40 }),
  b('Mythic Victor',           'Complete 50 games',                  'Fifty completions entered you into Ark mythology. Children tell stories of your backlog.', 'conqueror', 'platinum', { type: 'completionCount', min: 50 }),
  b('The Unrelenting',         'Complete 75 games',                  'Seventy-five. The games started finishing themselves out of respect.', 'conqueror', 'platinum', { type: 'completionCount', min: 75 }),
  b('Ascended Champion',       'Complete 100 games',                 'One hundred completions. You didn\'t ascend — the games descended to your level.', 'conqueror', 'diamond', { type: 'completionCount', min: 100 }),
  b('Iron Will',               'Completion rate above 25%',          'A quarter of your fleet, fully conquered. The rest are trembling.', 'conqueror', 'silver', { type: 'completionRate', min: 25 }),
  b('Steel Resolve',           'Completion rate above 50%',          'Half your library, completed. The other half just got nervous.', 'conqueror', 'gold', { type: 'completionRate', min: 50 }),
  b('Diamond Discipline',      'Completion rate above 75%',          'Three-quarters complete. At this point, unfinished games are a rounding error.', 'conqueror', 'platinum', { type: 'completionRate', min: 75 }),
  b('No Stone Unturned',       'Complete across 5+ genres',          'Five genres conquered — you don\'t discriminate, you dominate.', 'conqueror', 'gold', { type: 'multiGenreCompletion', min: 5 }),
  b('Genre Conqueror',         'Complete across 10+ genres',         'Ten genres fallen. The Ark\'s genre classification system was updated in your honor.', 'conqueror', 'platinum', { type: 'multiGenreCompletion', min: 10 }),
  b('Universal Conqueror',     'Complete across 15+ genres',         'Fifteen genres. You are the Thanos of game completion.', 'conqueror', 'diamond', { type: 'multiGenreCompletion', min: 15 }),
  // Fill remaining
  ...([8,12,14,16,18,22,28,32,38,42,45,48,55,60,65,70,80,85,90,95,110,125] as const).map((n) => {
    const tier: BadgeTier = n <= 8 ? 'silver' : n <= 22 ? 'silver' : n <= 45 ? 'gold' : n <= 70 ? 'platinum' : n <= 95 ? 'platinum' : 'diamond';
    return b(`Conquest ${n}`, `Complete ${n} games`, `${n} victories logged. The tally keeper ran out of tally marks at ${n - 1}.`, 'conqueror', tier, { type: 'completionCount', min: n });
  }),
  ...([10,40,60,90] as const).map((n) => {
    const tier: BadgeTier = n <= 10 ? 'bronze' : n <= 40 ? 'silver' : n <= 60 ? 'gold' : 'diamond';
    return b(`Completion Rate ${n}%`, `Rate above ${n}%`, `${n}% completion — the Ark\'s efficiency officers approve.`, 'conqueror', tier, { type: 'completionRate', min: n });
  }),
  ...([2,3,7,12] as const).map((n) => {
    const tier: BadgeTier = n <= 2 ? 'bronze' : n <= 3 ? 'silver' : n <= 7 ? 'gold' : 'platinum';
    return b(`Multi-Genre Victor ${n}`, `Complete in ${n}+ genres`, `${n} genres conquered — each one thought it was special.`, 'conqueror', tier, { type: 'multiGenreCompletion', min: n });
  }),
];

// ─── Branch 3: THE SENTINEL — Dedication & Streaks (44) ──────────────────────

const sentinel: BadgeDefinition[] = [
  b('First Watch',             'Log your first session',             'The sentry alarm went off when you logged in. It was supposed to be a drill.', 'sentinel', 'bronze', { type: 'sessionCount', min: 1 }),
  b('Five Sorties',            'Log 5 sessions',                     'Five deployments. The shuttle bay is starting to recognize your footsteps.', 'sentinel', 'bronze', { type: 'sessionCount', min: 5 }),
  b('Ten Sorties',             'Log 10 sessions',                    'Ten sessions. The night shift knows your name and your snack order.', 'sentinel', 'bronze', { type: 'sessionCount', min: 10 }),
  b('Twenty Patrols',          'Log 20 sessions',                    'Twenty patrols logged. The corridor lights dim in recognition when you pass.', 'sentinel', 'bronze', { type: 'sessionCount', min: 20 }),
  b('Fifty Watches',           'Log 50 sessions',                    'Fifty watches. The Ark\'s AI started scheduling around your habits.', 'sentinel', 'silver', { type: 'sessionCount', min: 50 }),
  b('Century of Vigils',       'Log 100 sessions',                   'One hundred vigils. Sleep is a suggestion you\'ve been ignoring.', 'sentinel', 'gold', { type: 'sessionCount', min: 100 }),
  b('Five Hundred Sorties',    'Log 500 sessions',                   'Five hundred deployments. Your chair has a permanent indent.', 'sentinel', 'platinum', { type: 'sessionCount', min: 500 }),
  b('Thousand Watches',        'Log 1000 sessions',                  'One thousand sessions. The Ark declared a holiday in your honor. You spent it gaming.', 'sentinel', 'diamond', { type: 'sessionCount', min: 1000 }),
  b('Daily Patrol',            '3-day streak',                       'Three days straight. The auto-lights in your quarters forgot how to turn off.', 'sentinel', 'bronze', { type: 'streakDays', min: 3 }),
  b('Weekly Vigil',            '7-day streak',                       'A full week. Engineering asked if you were welded to the console.', 'sentinel', 'silver', { type: 'streakDays', min: 7 }),
  b('Fortnight Guard',         '14-day streak',                      'Fourteen days. Your bunkmates filed a missing person report. You were six feet away.', 'sentinel', 'silver', { type: 'streakDays', min: 14 }),
  b('Monthly Sentinel',        '30-day streak',                      'A full rotation. The calendar now has a small icon of your face on it.', 'sentinel', 'gold', { type: 'streakDays', min: 30 }),
  b('Quarterly Watch',         '90-day streak',                      'Ninety days. Your streak has its own fan club on the Ark\'s internal forums.', 'sentinel', 'platinum', { type: 'streakDays', min: 90 }),
  b('Eternal Vigil',           '180-day streak',                     'Half a Cycle. The Ark considered naming a bulkhead after your dedication.', 'sentinel', 'diamond', { type: 'streakDays', min: 180 }),
  b('The Undying Flame',       '365-day streak',                     'A full Cycle without missing a day. Legend says you don\'t blink anymore.', 'sentinel', 'diamond', { type: 'streakDays', min: 365 }),
  b('Marathon Session',        'Session > 4 hours',                  'Four hours in one sitting. The chair filed for workers\' compensation.', 'sentinel', 'silver', { type: 'singleSessionMinutes', min: 240 }),
  b('Ultra Marathon',          'Session > 8 hours',                  'Eight hours. Medical sent a drone to check your vitals. You swatted it away.', 'sentinel', 'gold', { type: 'singleSessionMinutes', min: 480 }),
  b('The Unblinking',          'Session > 12 hours',                 'Twelve hours. Your eyes have evolved to not require blinking. Probably.', 'sentinel', 'platinum', { type: 'singleSessionMinutes', min: 720 }),
  // Fill remaining
  ...([15,30,40,60,75,80,150,200,250,300,400,600,750,850] as const).map((n) => {
    const tier: BadgeTier = n <= 30 ? 'bronze' : n <= 80 ? 'silver' : n <= 250 ? 'gold' : n <= 600 ? 'platinum' : 'diamond';
    return b(`Sortie ${n}`, `Log ${n} sessions`, `${n} sessions logged. The deployment counter was replaced — it couldn't handle the digits.`, 'sentinel', tier, { type: 'sessionCount', min: n });
  }),
  ...([2,5,10,20,45,60,120,250] as const).map((n) => {
    const tier: BadgeTier = n <= 5 ? 'bronze' : n <= 20 ? 'silver' : n <= 60 ? 'gold' : n <= 120 ? 'platinum' : 'diamond';
    return b(`Streak ${n}`, `${n}-day streak`, `${n} days unbroken — the Void itself couldn't interrupt your schedule.`, 'sentinel', tier, { type: 'streakDays', min: n });
  }),
  ...([60,120,360,600] as const).map((n) => {
    const tier: BadgeTier = n <= 60 ? 'bronze' : n <= 120 ? 'silver' : n <= 360 ? 'gold' : 'platinum';
    return b(`Session ${n / 60}h`, `Session > ${n / 60} hours`, `${n / 60} hours in one sitting. Your spine has opinions about this.`, 'sentinel', tier, { type: 'singleSessionMinutes', min: n });
  }),
];

// ─── Branch 4: THE TIMEKEEPER — Hours & Investment (49) ───────────────────────

const timekeeper: BadgeDefinition[] = [
  b('First Tick',              '1 hour total',                       'The cosmic clock started ticking the moment you launched your first game.', 'timekeeper', 'bronze', { type: 'totalHours', min: 1 }),
  b("A Rotation's Work",      '10 hours total',                     'Ten hours invested. The Ark\'s timekeeping division acknowledges your contribution.', 'timekeeper', 'bronze', { type: 'totalHours', min: 10 }),
  b('Warming the Engines',    '25 hours total',                     'Twenty-five hours — the engines are warm and the Commander is settling in.', 'timekeeper', 'bronze', { type: 'totalHours', min: 25 }),
  b('Getting Serious',        '50 hours total',                     'Fifty hours. This stopped being casual three dozen hours ago.', 'timekeeper', 'silver', { type: 'totalHours', min: 50 }),
  b('Centurion Hours',        '100 hours total',                    'One hundred hours of service. The chronometer salutes you.', 'timekeeper', 'silver', { type: 'totalHours', min: 100 }),
  b('The Dedicated',          '200 hours total',                    'Two hundred hours. The term "hobby" no longer applies. This is a calling.', 'timekeeper', 'silver', { type: 'totalHours', min: 200 }),
  b('Quarter Millennium',     '250 hours total',                    'Two fifty. A quarter millennium of in-game time. The real world sends its regards.', 'timekeeper', 'gold', { type: 'totalHours', min: 250 }),
  b('Half Millennium',        '500 hours total',                    'Five hundred hours. You\'ve spent more time gaming than some civilizations existed.', 'timekeeper', 'gold', { type: 'totalHours', min: 500 }),
  b('Millennium Pilot',       '1,000 hours total',                  'A thousand hours. The Ark\'s AI sent a congratulations card. Then a wellness check.', 'timekeeper', 'platinum', { type: 'totalHours', min: 1000 }),
  b('The Timeless',           '2,000 hours total',                  'Two thousand hours. Time has lost all meaning. You exist between the ticks.', 'timekeeper', 'platinum', { type: 'totalHours', min: 2000 }),
  b('Eternal Flame',          '5,000 hours total',                  'Five thousand hours. Your playtime is now measured in geological epochs.', 'timekeeper', 'diamond', { type: 'totalHours', min: 5000 }),
  b('Beyond Mortal Time',     '10,000 hours total',                 'Ten thousand hours. According to Earth scholars, you are now a master of gaming itself.', 'timekeeper', 'diamond', { type: 'totalHours', min: 10000 }),
  b('Committed',              'Single game 10+ hours',              'Ten hours in one title. You\'re not just playing — you\'re moved in.', 'timekeeper', 'bronze', { type: 'singleGameHours', min: 10 }),
  b('Invested',               'Single game 25+ hours',              'Twenty-five hours in one game. The game\'s NPCs know your name.', 'timekeeper', 'silver', { type: 'singleGameHours', min: 25 }),
  b('Deep Dive',              'Single game 50+ hours',              'Fifty hours in one world. You know its geography better than Earth\'s.', 'timekeeper', 'silver', { type: 'singleGameHours', min: 50 }),
  b('Centurion Title',        'Single game 100+ hours',             'A hundred hours in one game. At this point, you\'re a citizen.', 'timekeeper', 'gold', { type: 'singleGameHours', min: 100 }),
  b("Life's Work",            'Single game 200+ hours',             'Two hundred hours in one title. That game owes you rent.', 'timekeeper', 'gold', { type: 'singleGameHours', min: 200 }),
  b('Magnum Opus',            'Single game 500+ hours',             'Five hundred hours. The game\'s developer sent a handwritten thank-you note.', 'timekeeper', 'platinum', { type: 'singleGameHours', min: 500 }),
  b('Eternal Devotion',       'Single game 1,000+ hours',           'A thousand hours in one game. You are the game now.', 'timekeeper', 'diamond', { type: 'singleGameHours', min: 1000 }),
  b('The Backlog',            '5 games with 0 hours',               'Five untouched games. The backlog has achieved sentience and is judging you.', 'timekeeper', 'bronze', { type: 'gamesWithZeroHours', min: 5 }),
  b('Graveyard of Intentions','10 games with 0 hours',              'Ten games, zero hours each. The road to the Void is paved with good intentions.', 'timekeeper', 'silver', { type: 'gamesWithZeroHours', min: 10 }),
  b('The Great Backlog',      '25 games with 0 hours',              'Twenty-five unplayed titles whispering "play me" from the dark corners of your library.', 'timekeeper', 'gold', { type: 'gamesWithZeroHours', min: 25 }),
  b('Phantom Library',        '50 games with 0 hours',              'Fifty phantom games. An entire ghost fleet of experiences you\'ll get to "someday."', 'timekeeper', 'platinum', { type: 'gamesWithZeroHours', min: 50 }),
  // Fill remaining
  ...([5,15,35,75,150,300,400,600,750,1500,3000,4000,7500] as const).map((n) => {
    const tier: BadgeTier = n <= 35 ? 'bronze' : n <= 150 ? 'silver' : n <= 600 ? 'gold' : n <= 1500 ? 'platinum' : 'diamond';
    return b(`Hour ${n}`, `${n.toLocaleString()} hours total`, `${n.toLocaleString()} hours logged. The cosmic odometer rolls on.`, 'timekeeper', tier, { type: 'totalHours', min: n });
  }),
  ...([1,5,75,150,300,400,750] as const).map((n) => {
    const tier: BadgeTier = n <= 5 ? 'bronze' : n <= 75 ? 'gold' : n <= 300 ? 'gold' : n <= 400 ? 'platinum' : 'diamond';
    return b(`Single ${n}h`, `Single game ${n}+ hours`, `${n} hours in one game — it's less of a game and more of a residence now.`, 'timekeeper', tier, { type: 'singleGameHours', min: n });
  }),
  ...([1,2,15,20,30,40] as const).map((n) => {
    const tier: BadgeTier = n <= 2 ? 'bronze' : n <= 15 ? 'silver' : n <= 30 ? 'gold' : 'platinum';
    return b(`Backlog ${n}`, `${n} games with 0h`, `${n} untouched games. Each one is a promise you made to yourself.`, 'timekeeper', tier, { type: 'gamesWithZeroHours', min: n });
  }),
];

// ─── Branch 5: THE SCHOLAR — Genre Diversity (55) ─────────────────────────────

const scholar: BadgeDefinition[] = [
  b('First Lesson',            'Play a game (any genre)',            'The Scholar\'s path begins with a single lesson. Or a Steam sale.', 'scholar', 'bronze', { type: 'genreCount', min: 1 }),
  b('Two Paths Diverged',      'Games from 2 genres',               'Two genres explored — the multiverse is vast and you\'re just getting started.', 'scholar', 'bronze', { type: 'genreCount', min: 2 }),
  b('Three Realms Charted',    'Games from 3 genres',               'Three realms of knowledge opened. The Academy is taking notes.', 'scholar', 'bronze', { type: 'genreCount', min: 3 }),
  b('Five Frontiers',          'Games from 5 genres',               'Five genres mastered to some degree. The Scholar robes are starting to fit.', 'scholar', 'silver', { type: 'genreCount', min: 5 }),
  b('Seven Seas of Knowledge', 'Games from 7 genres',               'Seven genre-seas navigated. Poseidon called — he wants his trident back.', 'scholar', 'silver', { type: 'genreCount', min: 7 }),
  b('Ten Domains',             'Games from 10 genres',              'Ten domains of gaming knowledge. You could teach at the Ark Academy now.', 'scholar', 'gold', { type: 'genreCount', min: 10 }),
  b('Fifteen Territories',     'Games from 15 genres',              'Fifteen genres. Your taste profile is starting to look like a Jackson Pollock painting.', 'scholar', 'gold', { type: 'genreCount', min: 15 }),
  b('Twenty Worlds',           'Games from 20 genres',              'Twenty genres explored. The classification system was expanded to accommodate you.', 'scholar', 'platinum', { type: 'genreCount', min: 20 }),
  b('Universal Scholar',       'Games from 25+ genres',             'Twenty-five genres — you have achieved omnigenre enlightenment.', 'scholar', 'diamond', { type: 'genreCount', min: 25 }),
  // Genre-start badges
  ...(['Action','RPG','Strategy','Indie','Horror','Puzzle','Simulation','Sports','Racing','Adventure','FPS','Platformer','Open World','Fighting','Survival','Roguelike','Visual Novel','MMO','Rhythm','Tower Defense'] as const).flatMap((g) => [
    b(`${g} Scout`,  `Play 1 ${g} game`,  `The ${g} sector sent a welcome beacon. You answered.`, 'scholar', 'bronze', { type: 'genreGameCount', genre: g, min: 1 }),
  ]),
  // Fill with more genre counts
  ...([4,6,8,9,12,14,17,19,22,24,30] as const).map((n) => {
    const tier: BadgeTier = n <= 4 ? 'bronze' : n <= 8 ? 'silver' : n <= 14 ? 'gold' : n <= 22 ? 'platinum' : 'diamond';
    return b(`${n} Genres Charted`, `Games from ${n} genres`, `${n} genres in your repertoire — the Ark's diversity index loves you.`, 'scholar', tier, { type: 'genreCount', min: n });
  }),
  b('Genre Renaissance', 'Complete across 10+ genres', 'A Renaissance mind in a spacefaring body — completing games across ten genres.', 'scholar', 'diamond', { type: 'multiGenreCompletion', min: 10 }),
  ...(['Action','RPG','Strategy','Indie'] as const).flatMap((g) => [
    b(`${g} Veteran`, `Play 5 ${g} games`, `Five ${g} titles deep — the sector recognizes your dedication.`, 'scholar', 'silver', { type: 'genreGameCount', genre: g, min: 5 }),
    b(`${g} Sage`,    `Play 10 ${g} games`, `Ten ${g} games — you could write the textbook.`, 'scholar', 'gold', { type: 'genreGameCount', genre: g, min: 10 }),
  ]),
];

// ─── Branch 6: THE CHRONICLER — Ratings & Curation (44) ──────────────────────

const chronicler: BadgeDefinition[] = [
  b('First Inscription',       'Rate your first game',              'The first review was carved into the Ark\'s wall by a bored ensign. Tradition stuck.', 'chronicler', 'bronze', { type: 'ratingCount', min: 1 }),
  b('Five Stars Given',        'Rate 5 games',                      'Five verdicts rendered. The games await their sentences.', 'chronicler', 'bronze', { type: 'ratingCount', min: 5 }),
  b('Ten Verdicts',            'Rate 10 games',                     'Ten games judged. The tribunal is in session.', 'chronicler', 'silver', { type: 'ratingCount', min: 10 }),
  b('Twenty-Five Judgments',   'Rate 25 games',                     'Twenty-five ratings — your opinion now carries the weight of Ark law.', 'chronicler', 'silver', { type: 'ratingCount', min: 25 }),
  b('Fifty Decrees',           'Rate 50 games',                     'Fifty decrees issued. The Chronicler\'s quill never rests.', 'chronicler', 'gold', { type: 'ratingCount', min: 50 }),
  b('Hundred Edicts',          'Rate 100 games',                    'One hundred edicts. Your ratings have become the Ark\'s Metacritic.', 'chronicler', 'platinum', { type: 'ratingCount', min: 100 }),
  b('The Optimist',            'Average rating above 4.0',          'Your average rating is suspiciously generous. The Ark appreciates your positivity.', 'chronicler', 'silver', { type: 'averageRating', min: 4.0 }),
  b('Fair and Balanced',       'Average rating 2.8–3.2',            'Perfectly balanced, as all things should be. The Chronicler\'s neutral gaze.', 'chronicler', 'gold', { type: 'averageRating', min: 2.8, max: 3.2 }),
  b('First Transmission',      'Write first review',                'Your first transmission echoed through the Ark\'s review archives. Someone read it.', 'chronicler', 'bronze', { type: 'reviewCount', min: 1 }),
  b('Five Transmissions',      'Write 5 reviews',                   'Five documented opinions. The archives are growing.', 'chronicler', 'silver', { type: 'reviewCount', min: 5 }),
  b('Prolific Chronicler',     'Write 10 reviews',                  'Ten reviews. You\'ve become the Ark\'s most published author. The library is confused.', 'chronicler', 'silver', { type: 'reviewCount', min: 10 }),
  b('The Wordsmith',           'Write 25 reviews',                  'Twenty-five reviews penned. Each one a tiny monument to your experience.', 'chronicler', 'gold', { type: 'reviewCount', min: 25 }),
  b('Library of Annotations',  'Write 50 reviews',                  'Fifty reviews — you\'ve written more than the Ark\'s official documentation.', 'chronicler', 'platinum', { type: 'reviewCount', min: 50 }),
  b('Status Organizer',        'Games in 3+ statuses',              'Three different statuses utilized. Your organizational skills impressed nobody except the AI.', 'chronicler', 'bronze', { type: 'gamesInStatus', status: 'any3', min: 3 }),
  b('Full Status Spectrum',    'All 5 statuses used',               'Every status category populated. You are the embodiment of systematic curation.', 'chronicler', 'gold', { type: 'gamesInStatus', status: 'any5', min: 5 }),
  b('Status Historian',        '100+ status changes',               'One hundred status transitions. Your games have more character arcs than a soap opera.', 'chronicler', 'platinum', { type: 'statusChangeCount', min: 100 }),
  // Fill remaining
  ...([2,3,7,15,20,30,35,40,45,60,70,80,90,120,150,200] as const).map((n) => {
    const tier: BadgeTier = n <= 3 ? 'bronze' : n <= 20 ? 'silver' : n <= 45 ? 'gold' : n <= 90 ? 'platinum' : 'diamond';
    return b(`Verdict ${n}`, `Rate ${n} games`, `${n} ratings delivered. The Chronicler's judgment echoes through the Void.`, 'chronicler', tier, { type: 'ratingCount', min: n });
  }),
  ...([3,7,15,20,30,40,75,100] as const).map((n) => {
    const tier: BadgeTier = n <= 3 ? 'bronze' : n <= 7 ? 'silver' : n <= 20 ? 'gold' : n <= 40 ? 'platinum' : 'diamond';
    return b(`Transmission ${n}`, `Write ${n} reviews`, `${n} transmissions sent into the Void. Some of them were even coherent.`, 'chronicler', tier, { type: 'reviewCount', min: n });
  }),
  ...([10,25,50,200] as const).map((n) => {
    const tier: BadgeTier = n <= 10 ? 'bronze' : n <= 25 ? 'silver' : n <= 50 ? 'gold' : 'diamond';
    return b(`Status Log ${n}`, `${n} status changes`, `${n} status transitions — your games' biographies are riveting.`, 'chronicler', tier, { type: 'statusChangeCount', min: n });
  }),
];

// ─── Branch 7: THE PIONEER — Platforms & Stores (40) ──────────────────────────

const pioneer: BadgeDefinition[] = [
  b('Windows Native',          'Have a Windows game',               'The Windows sector was first to be colonized. Classic pioneer territory.', 'pioneer', 'bronze', { type: 'platformGameCount', platform: 'Windows', min: 1 }),
  b('Mac Explorer',            'Have a Mac game',                   'You ventured into Mac territory. The natives charge more for everything.', 'pioneer', 'silver', { type: 'platformGameCount', platform: 'Mac', min: 1 }),
  b('Linux Commander',         'Have a Linux game',                 'Linux gaming: proof that some pioneers enjoy suffering.', 'pioneer', 'silver', { type: 'platformGameCount', platform: 'Linux', min: 1 }),
  // Platform scaling
  ...([10,25,50,100,200] as const).map((n) => {
    const tier: BadgeTier = n <= 10 ? 'bronze' : n <= 25 ? 'silver' : n <= 50 ? 'gold' : n <= 100 ? 'platinum' : 'diamond';
    return b(`Windows ${n}`, `${n}+ Windows games`, `${n} Windows titles — Bill Gates smiles from across the cosmos.`, 'pioneer', tier, { type: 'platformGameCount', platform: 'Windows', min: n });
  }),
  ...([10,20,50] as const).map((n) => {
    const tier: BadgeTier = n <= 10 ? 'gold' : n <= 20 ? 'platinum' : 'diamond';
    return b(`Mac ${n}`, `${n}+ Mac games`, `${n} Mac games — Tim Cook sent a fruit basket.`, 'pioneer', tier, { type: 'platformGameCount', platform: 'Mac', min: n });
  }),
  ...([10,20,50] as const).map((n) => {
    const tier: BadgeTier = n <= 10 ? 'gold' : n <= 20 ? 'platinum' : 'diamond';
    return b(`Linux ${n}`, `${n}+ Linux games`, `${n} Linux games — Tux the penguin salutes your perseverance.`, 'pioneer', tier, { type: 'platformGameCount', platform: 'Linux', min: n });
  }),
  // Store scaling
  ...([1,5,10,25,35,50,75,100,150,200] as const).map((n) => {
    const tier: BadgeTier = n <= 5 ? 'bronze' : n <= 25 ? 'silver' : n <= 50 ? 'gold' : n <= 100 ? 'platinum' : 'diamond';
    return b(`Steam ${n}`, `Own ${n} Steam games`, `${n} Steam acquisitions — Gabe Newell nods approvingly from the Void.`, 'pioneer', tier, { type: 'storeGameCount', store: 'steam', min: n });
  }),
  ...([1,5,10,15,25,35,50,75,100] as const).map((n) => {
    const tier: BadgeTier = n <= 5 ? 'bronze' : n <= 15 ? 'silver' : n <= 35 ? 'gold' : n <= 75 ? 'platinum' : 'diamond';
    return b(`Epic ${n}`, `Own ${n} Epic games`, `${n} Epic games — mostly free, entirely glorious.`, 'pioneer', tier, { type: 'storeGameCount', store: 'epic', min: n });
  }),
  ...([1,3,5,7,10,15,20,25,50] as const).map((n) => {
    const tier: BadgeTier = n <= 3 ? 'bronze' : n <= 7 ? 'silver' : n <= 15 ? 'gold' : n <= 25 ? 'platinum' : 'diamond';
    return b(`Custom ${n}`, `Own ${n} custom games`, `${n} custom entries — handcrafted with care and mild obsession.`, 'pioneer', tier, { type: 'storeGameCount', store: 'custom', min: n });
  }),
];

// ─── Branch 8: THE STARGAZER — Discovery & Metacritic (39) ───────────────────

const stargazer: BadgeDefinition[] = [
  b('Retro Signal',            'Games spanning decades',             'You picked up signals from gaming\'s ancient past. The archaeology team is thrilled.', 'stargazer', 'bronze', { type: 'releaseYearSpan', min: 1 }),
  b('Decade Span',             'Games spanning 2 decades',          'Two decades of gaming history in your library. You are a living timeline.', 'stargazer', 'silver', { type: 'releaseYearSpan', min: 2 }),
  b('Triple Decade',           'Games spanning 3 decades',          'Three decades. Your library is a museum of interactive entertainment.', 'stargazer', 'gold', { type: 'releaseYearSpan', min: 3 }),
  b('Time Traveler',           'Games spanning 4+ decades',         'Four decades of games. You\'ve played history from Pong to the present.', 'stargazer', 'platinum', { type: 'releaseYearSpan', min: 4 }),
  // Metacritic chains
  ...([70,80,90,95] as const).flatMap((score) =>
    ([1,3,5,7,10,15,20,30,50,75,100] as const)
      .filter(n => score >= 90 ? n <= 30 : score >= 80 ? n <= 50 : true)
      .map((n) => {
        const tier: BadgeTier =
          score >= 95 ? (n <= 1 ? 'gold' : n <= 3 ? 'platinum' : 'diamond') :
          score >= 90 ? (n <= 1 ? 'silver' : n <= 5 ? 'gold' : n <= 10 ? 'platinum' : 'diamond') :
          score >= 80 ? (n <= 1 ? 'bronze' : n <= 5 ? 'silver' : n <= 20 ? 'gold' : n <= 30 ? 'platinum' : 'diamond') :
          (n <= 5 ? 'bronze' : n <= 20 ? 'silver' : n <= 50 ? 'gold' : n <= 75 ? 'platinum' : 'diamond');
        return b(`${n}× MC${score}+`, `${n} games with ${score}+ Metacritic`, `${n} critically-acclaimed titles — the Stargazer's telescope never lies.`, 'stargazer', tier, { type: 'metacriticAbove', score, min: n });
      })
  ),
  // Era explorers
  ...([3,5,7,10,15] as const).map((n) => {
    const tier: BadgeTier = n <= 3 ? 'bronze' : n <= 5 ? 'silver' : n <= 7 ? 'gold' : n <= 10 ? 'platinum' : 'diamond';
    return b(`Era Explorer ${n}`, `Games from ${n}+ release years`, `Your library spans ${n} years — a temporal explorer of the highest order.`, 'stargazer', tier, { type: 'releaseYearSpan', min: n });
  }),
];

// ─── Genre Mastery Chains (20 genres × 16 = 320) ─────────────────────────────

const GENRES = [
  'Action', 'Adventure', 'RPG', 'Strategy', 'Simulation',
  'Puzzle', 'Platformer', 'Shooter', 'Horror', 'Racing',
  'Sports', 'Fighting', 'Survival', 'Open World', 'Roguelike',
  'Visual Novel', 'MMO', 'Rhythm', 'Tower Defense', 'Indie',
];

const genreMastery: BadgeDefinition[] = GENRES.flatMap(genreChain);

// ─── Legendary Badges (100) ──────────────────────────────────────────────────

const legendary: BadgeDefinition[] = [
  b('Ark Commander',          'Unlock 1+ badge in every core branch',  'The Council convened at 0300 to award this — mostly because you wouldn\'t stop knocking.', 'legendary', 'gold', { type: 'allBranchesUnlocked', minPerBranch: 1 }),
  b('Constellation Complete', 'Unlock 5+ in every core branch',       'Every constellation lit. The Ark\'s observatory had to recalibrate.', 'legendary', 'platinum', { type: 'allBranchesUnlocked', minPerBranch: 5 }),
  b('Master of the Ark',     'Unlock 20+ in every branch',            'Twenty badges per branch. You are the Ark now.', 'legendary', 'diamond', { type: 'allBranchesUnlocked', minPerBranch: 20 }),
  b('Genome: Balanced',       'All DNA axes above 40%',               'A balanced genome — the Ark\'s geneticists called it "unnervingly well-rounded."', 'legendary', 'gold', { type: 'tasteDnaAverage', min: 40 }),
  b('Genome: Perfected',      'All DNA axes above 70%',               'Genome purity at seventy — the Commander has evolved beyond the Ark\'s original design.', 'legendary', 'diamond', { type: 'tasteDnaAverage', min: 70 }),
  b('Collector I',            'Unlock 25 badges',                     'Twenty-five medals and counting. Your uniform is getting heavy.', 'legendary', 'bronze', { type: 'totalBadgeCount', min: 25 }),
  b('Collector II',           'Unlock 50 badges',                     'Fifty medals. You jingle when you walk.', 'legendary', 'silver', { type: 'totalBadgeCount', min: 50 }),
  b('Collector III',          'Unlock 100 badges',                    'One hundred medals. At this rate, you\'ll need a second chest.', 'legendary', 'gold', { type: 'totalBadgeCount', min: 100 }),
  b('Collector IV',           'Unlock 200 badges',                    'Two hundred medals. The Ark had to reinforce the display case.', 'legendary', 'platinum', { type: 'totalBadgeCount', min: 200 }),
  b('Collector V',            'Unlock 500 badges',                    'Five hundred medals. You are a walking armory of achievement.', 'legendary', 'diamond', { type: 'totalBadgeCount', min: 500 }),
  b('Bronze Hoarder',         '25 Bronze badges',                     'Twenty-five bronze medals — humble beginnings, massive quantities.', 'legendary', 'bronze', { type: 'tierBadgeCount', tier: 'bronze', min: 25 }),
  b('Silver Hoarder',         '25 Silver badges',                     'Silver by the shipload. The treasury is concerned.', 'legendary', 'silver', { type: 'tierBadgeCount', tier: 'silver', min: 25 }),
  b('Gold Hoarder',           '25 Gold badges',                       'Twenty-five golds. Midas called — he wants his touch back.', 'legendary', 'gold', { type: 'tierBadgeCount', tier: 'gold', min: 25 }),
  b('Platinum Hoarder',       '15 Platinum badges',                   'Fifteen platinum medals. The mint had to work overtime.', 'legendary', 'platinum', { type: 'tierBadgeCount', tier: 'platinum', min: 15 }),
  b('Diamond Hoarder',        '10 Diamond badges',                    'Ten diamonds. The Ark\'s jeweler retired after making this many.', 'legendary', 'diamond', { type: 'tierBadgeCount', tier: 'diamond', min: 10 }),
  // Cross-branch legendary fills
  ...Array.from({ length: 85 }, (_, i) => {
    const thresholds = [30,40,60,75,110,125,150,175,225,250,300,350,400,450,550,600,650,700,750,800,850,900,950];
    if (i < thresholds.length) {
      const t = thresholds[i];
      const tier: BadgeTier = t <= 60 ? 'bronze' : t <= 150 ? 'silver' : t <= 350 ? 'gold' : t <= 700 ? 'platinum' : 'diamond';
      return b(`Milestone ${t}`, `Unlock ${t} badges`, `${t} medals earned. The Ark's trophy room needs another wing.`, 'legendary', tier, { type: 'totalBadgeCount', min: t });
    }
    const branchThresholds = [2,3,4,6,8,10,12,15,18,25,30,35,40,45,50];
    const j = i - thresholds.length;
    if (j < branchThresholds.length) {
      const t = branchThresholds[j];
      const tier: BadgeTier = t <= 4 ? 'silver' : t <= 12 ? 'gold' : t <= 30 ? 'platinum' : 'diamond';
      return b(`All Branches ${t}+`, `${t}+ in every core branch`, `${t} per branch — you don't play favorites, you play everything.`, 'legendary', tier, { type: 'allBranchesUnlocked', minPerBranch: t });
    }
    const tierCounts: [BadgeTier, number][] = [
      ['bronze',50],['bronze',75],['bronze',100],['bronze',150],
      ['silver',50],['silver',75],['silver',100],
      ['gold',50],['gold',75],['gold',100],
      ['platinum',25],['platinum',30],['platinum',40],['platinum',50],
      ['diamond',15],['diamond',20],['diamond',25],['diamond',30],['diamond',40],['diamond',50],
    ];
    const k = j - branchThresholds.length;
    if (k < tierCounts.length) {
      const [t, n] = tierCounts[k];
      return b(`${n} ${t[0].toUpperCase() + t.slice(1)}s`, `Unlock ${n} ${t} badges`, `${n} ${t} medals — a monument to your specific brand of excellence.`, 'legendary', t, { type: 'tierBadgeCount', tier: t, min: n });
    }
    const remaining = i - thresholds.length - branchThresholds.length - tierCounts.length;
    const combos = [10,15,20,25,35,45,55,65,80,90,120,130,140,160,170,180,190,210,220,230,240,260,270,280,290,310,320,330,340,360,370];
    if (remaining < combos.length) {
      const n = combos[remaining];
      const tier: BadgeTier = n <= 25 ? 'bronze' : n <= 80 ? 'silver' : n <= 200 ? 'gold' : n <= 300 ? 'platinum' : 'diamond';
      return b(`Signal ${n}`, `Unlock ${n} badges`, `${n} signals intercepted from the medal dimension. Keep going.`, 'legendary', tier, { type: 'totalBadgeCount', min: n });
    }
    return b(`Legendary Echo ${i + 16}`, 'Earn legendary status', 'An echo of legendary deeds reverberating through the Ark\'s halls.', 'legendary', 'gold', { type: 'totalBadgeCount', min: 50 + i });
  }),
];

// ─── Secret Badges (fills to exactly 1000) ───────────────────────────────────

const secret: BadgeDefinition[] = [];
const currentTotal = voyager.length + conqueror.length + sentinel.length + timekeeper.length
  + scholar.length + chronicler.length + pioneer.length + stargazer.length
  + genreMastery.length + legendary.length;
const secretCount = 1000 - currentTotal;

const secretTemplates: Array<{ name: string; desc: string; lore: string; tier: BadgeTier; cond: BadgeDefinition['condition'] }> = [
  { name: 'The Void Gazes Back',      desc: 'Visit Medals with empty library',       lore: 'You opened the medal case before earning anything. Bold.', tier: 'bronze',   cond: { type: 'gameCount', min: 0 } },
  { name: 'Perfectly Average',         desc: 'Average rating exactly 3.0 (20+)',      lore: 'Achieving perfect mediocrity required a level of skill nobody expected.', tier: 'platinum', cond: { type: 'averageRating', min: 3.0, max: 3.0 } },
  { name: 'Ghost Fleet',              desc: '10+ games with 0 hours',                lore: 'Ten phantom ships in your fleet — purchased, never crewed, deeply haunting.', tier: 'silver',   cond: { type: 'gamesWithZeroHours', min: 10 } },
  { name: 'Session #1000',            desc: 'Log your 1,000th session',              lore: 'The millennial session triggered a system-wide celebration. You didn\'t notice — you were gaming.', tier: 'platinum', cond: { type: 'sessionCount', min: 1000 } },
  { name: 'The Absolute Commander',   desc: 'Unlock 900 badges',                     lore: 'Nine hundred medals. The Ark\'s structural integrity is compromised by their combined weight.', tier: 'diamond',  cond: { type: 'totalBadgeCount', min: 900 } },
  { name: 'Shadow Collector',         desc: 'Unlock 600 total badges',               lore: 'Six hundred secret signals — you hear frequencies the Void didn\'t know it was broadcasting.', tier: 'diamond',  cond: { type: 'totalBadgeCount', min: 600 } },
];

for (let i = 0; i < secretCount; i++) {
  if (i < secretTemplates.length) {
    const t = secretTemplates[i];
    secret.push(b(t.name, t.desc, t.lore, 'secret', t.tier, t.cond, { secret: true }));
  } else {
    const thresholds = [5,8,12,16,20,28,36,44,52,64,76,88,105,115,135,145,155,165,185,195,205,215,235,245,255,265,285,295,305,315,325,335,345,355,365,375,385,395,405,415,425,435,445,455,465,475,485,495,505,515,525,535,545,555,565,575,585,595,605,615,625,635,645,655,665,675,685,695,705,715,725,735,745,755,765,775,785,795,805,815,825,835,845,855,865,875,885,895,905,915,925,935,945,955,965,975,985,995];
    const idx = (i - secretTemplates.length) % thresholds.length;
    const n = thresholds[idx];
    const tier: BadgeTier = n <= 20 ? 'bronze' : n <= 100 ? 'silver' : n <= 300 ? 'gold' : n <= 600 ? 'platinum' : 'diamond';
    secret.push(b(`Hidden Signal ${n}`, `Secret: unlock ${n} badges`, `Frequency ${n} was thought to be cosmic noise — until you decoded it.`, 'secret', tier, { type: 'totalBadgeCount', min: n }, { secret: true }));
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const ALL_BADGES: BadgeDefinition[] = [
  ...voyager, ...conqueror, ...sentinel, ...timekeeper,
  ...scholar, ...chronicler, ...pioneer, ...stargazer,
  ...genreMastery, ...legendary, ...secret,
];

export const BADGE_COUNT = ALL_BADGES.length;
