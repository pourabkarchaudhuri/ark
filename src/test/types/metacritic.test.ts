import { describe, it, expect } from 'vitest';
import { MetacriticReview, MetacriticGameResponse } from '@/types/metacritic';

describe('Metacritic Types', () => {
  it('MetacriticReview has correct structure', () => {
    const review: MetacriticReview = {
      review: 'An excellent game with stunning visuals.',
      review_critic: 'IGN',
      author: 'John Smith',
      review_date: 'Dec 15, 2024',
      review_grade: '90',
    };

    expect(review.review).toBe('An excellent game with stunning visuals.');
    expect(review.review_critic).toBe('IGN');
    expect(review.author).toBe('John Smith');
    expect(review.review_date).toBe('Dec 15, 2024');
    expect(review.review_grade).toBe('90');
  });

  it('MetacriticGameResponse has correct structure', () => {
    const response: MetacriticGameResponse = {
      title: 'Counter-Strike 2',
      poster: 'https://example.com/poster.jpg',
      score: 83,
      release_date: 'Sep 27, 2023',
      reviews: [
        {
          review: 'A worthy successor.',
          review_critic: 'GameSpot',
          author: 'Jane Doe',
          review_date: 'Sep 28, 2023',
          review_grade: '85',
        },
      ],
    };

    expect(response.title).toBe('Counter-Strike 2');
    expect(response.score).toBe(83);
    expect(response.reviews).toHaveLength(1);
    expect(response.reviews[0].review_critic).toBe('GameSpot');
  });

  it('MetacriticGameResponse handles empty reviews', () => {
    const response: MetacriticGameResponse = {
      title: 'Unknown Game',
      poster: '',
      score: 0,
      release_date: '',
      reviews: [],
    };

    expect(response.reviews).toHaveLength(0);
    expect(response.score).toBe(0);
  });

  it('calculates score color based on Metascore', () => {
    const getScoreColor = (score: number): string => {
      if (score >= 75) return 'green';
      if (score >= 50) return 'yellow';
      return 'red';
    };

    expect(getScoreColor(90)).toBe('green');
    expect(getScoreColor(75)).toBe('green');
    expect(getScoreColor(74)).toBe('yellow');
    expect(getScoreColor(50)).toBe('yellow');
    expect(getScoreColor(49)).toBe('red');
    expect(getScoreColor(0)).toBe('red');
  });
});

describe('Metacritic Review Formatting', () => {
  it('parses review grade as number', () => {
    const review: MetacriticReview = {
      review: 'Great game!',
      review_critic: 'Polygon',
      author: 'Test Author',
      review_date: 'Jan 1, 2024',
      review_grade: '85',
    };

    const gradeNum = parseInt(review.review_grade);
    expect(gradeNum).toBe(85);
    expect(typeof gradeNum).toBe('number');
  });

  it('handles missing review grade gracefully', () => {
    const review: MetacriticReview = {
      review: 'Good game!',
      review_critic: 'Kotaku',
      author: '',
      review_date: '',
      review_grade: '',
    };

    const gradeNum = parseInt(review.review_grade) || 0;
    expect(gradeNum).toBe(0);
  });

  it('truncates long reviews', () => {
    const longReview = 'A'.repeat(500);
    const truncate = (text: string, maxLength: number): string => {
      if (text.length <= maxLength) return text;
      return text.slice(0, maxLength) + '...';
    };

    const truncated = truncate(longReview, 100);
    expect(truncated.length).toBe(103); // 100 chars + '...'
    expect(truncated.endsWith('...')).toBe(true);
  });
});


