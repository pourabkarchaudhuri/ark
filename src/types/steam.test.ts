import { describe, it, expect } from 'vitest';
import {
  getSteamCoverUrl,
  getSteamHeaderUrl,
  STEAM_CDN_BASE,
  SteamMostPlayedGame,
  SteamAppDetails,
  SteamSearchItem,
  SteamReview,
  SteamReviewAuthor,
  SteamReviewsResponse,
  QueueStatus,
} from './steam';

describe('Steam URL Helpers', () => {
  it('getSteamCoverUrl returns correct URL format', () => {
    const url = getSteamCoverUrl(730);
    expect(url).toBe(`${STEAM_CDN_BASE}/730/library_600x900.jpg`);
  });

  it('getSteamHeaderUrl returns correct URL format', () => {
    const url = getSteamHeaderUrl(730);
    expect(url).toBe(`${STEAM_CDN_BASE}/730/header.jpg`);
  });

  it('STEAM_CDN_BASE is correct', () => {
    expect(STEAM_CDN_BASE).toBe('https://cdn.akamai.steamstatic.com/steam/apps');
  });
});

describe('Steam Type Definitions', () => {
  it('SteamMostPlayedGame type is correct', () => {
    const game: SteamMostPlayedGame = {
      rank: 1,
      appid: 730,
      last_week_rank: 1,
      peak_in_game: 1500000,
    };

    expect(game.rank).toBe(1);
    expect(game.appid).toBe(730);
    expect(game.peak_in_game).toBe(1500000);
  });

  it('SteamAppDetails type has all required fields', () => {
    const details: SteamAppDetails = {
      type: 'game',
      name: 'Test Game',
      steam_appid: 12345,
      required_age: 0,
      is_free: false,
      detailed_description: 'Description',
      about_the_game: 'About',
      short_description: 'Short',
      supported_languages: 'English',
      header_image: 'https://example.com/header.jpg',
      capsule_image: 'https://example.com/capsule.jpg',
      capsule_imagev5: 'https://example.com/capsulev5.jpg',
      website: 'https://example.com',
      pc_requirements: {
        minimum: 'Min specs',
        recommended: 'Rec specs',
      },
      platforms: {
        windows: true,
        mac: false,
        linux: false,
      },
    };

    expect(details.name).toBe('Test Game');
    expect(details.steam_appid).toBe(12345);
    expect(details.platforms.windows).toBe(true);
  });

  it('SteamSearchItem type is correct', () => {
    const searchItem: SteamSearchItem = {
      type: 'app',
      name: 'Search Result',
      id: 12345,
      tiny_image: 'https://example.com/tiny.jpg',
      streamingvideo: false,
    };

    expect(searchItem.name).toBe('Search Result');
    expect(searchItem.id).toBe(12345);
  });

  it('SteamReviewAuthor type is correct', () => {
    const author: SteamReviewAuthor = {
      steamid: '76561198000000000',
      num_games_owned: 150,
      num_reviews: 25,
      playtime_forever: 3600,
      playtime_last_two_weeks: 120,
      playtime_at_review: 3000,
      last_played: 1700000000,
    };

    expect(author.steamid).toBe('76561198000000000');
    expect(author.playtime_forever).toBe(3600);
    expect(author.num_reviews).toBe(25);
  });

  it('SteamReview type is correct', () => {
    const review: SteamReview = {
      recommendationid: '123456',
      author: {
        steamid: '76561198000000000',
        num_games_owned: 150,
        num_reviews: 25,
        playtime_forever: 3600,
        playtime_last_two_weeks: 120,
        playtime_at_review: 3000,
        last_played: 1700000000,
      },
      language: 'english',
      review: 'This is a great game!',
      timestamp_created: 1700000000,
      timestamp_updated: 1700000000,
      voted_up: true,
      votes_up: 50,
      votes_funny: 3,
      weighted_vote_score: '0.85',
      comment_count: 5,
      steam_purchase: true,
      received_for_free: false,
      written_during_early_access: false,
    };

    expect(review.recommendationid).toBe('123456');
    expect(review.voted_up).toBe(true);
    expect(review.review).toBe('This is a great game!');
    expect(review.author.playtime_forever).toBe(3600);
  });

  it('SteamReviewsResponse type is correct', () => {
    const response: SteamReviewsResponse = {
      success: 1,
      query_summary: {
        num_reviews: 10,
        review_score: 8,
        review_score_desc: 'Very Positive',
        total_positive: 85000,
        total_negative: 15000,
        total_reviews: 100000,
      },
      reviews: [],
    };

    expect(response.success).toBe(1);
    expect(response.query_summary.review_score_desc).toBe('Very Positive');
    expect(response.query_summary.total_reviews).toBe(100000);
  });

  it('QueueStatus type is correct', () => {
    const status: QueueStatus = {
      queueSize: 5,
    };

    expect(status.queueSize).toBe(5);
  });
});

describe('Steam Reviews Calculations', () => {
  it('calculates positive percentage from review summary', () => {
    const summary = {
      total_positive: 8500,
      total_negative: 1500,
      total_reviews: 10000,
    };

    const positivePercentage = Math.round((summary.total_positive / summary.total_reviews) * 100);
    expect(positivePercentage).toBe(85);
  });

  it('handles zero reviews edge case', () => {
    const summary = {
      total_positive: 0,
      total_negative: 0,
      total_reviews: 0,
    };

    const positivePercentage = summary.total_reviews > 0
      ? Math.round((summary.total_positive / summary.total_reviews) * 100)
      : null;

    expect(positivePercentage).toBeNull();
  });

  it('formats playtime correctly', () => {
    const formatPlaytime = (minutes: number): string => {
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    };

    expect(formatPlaytime(30)).toBe('30m');
    expect(formatPlaytime(60)).toBe('1h');
    expect(formatPlaytime(90)).toBe('1h 30m');
    expect(formatPlaytime(120)).toBe('2h');
    expect(formatPlaytime(3600)).toBe('60h');
  });
});


