/**
 * Metacritic API Type Definitions
 * Types for the chrismichaelps/metacritic package responses
 */

// Individual critic review
export interface MetacriticReview {
  review: string;
  review_critic: string;
  author: string;
  review_date: string;
  review_grade: string;
}

// Game reviews response from Metacritic
export interface MetacriticGameResponse {
  title: string;
  poster: string;
  score: number;
  release_date: string;
  reviews: MetacriticReview[];
}

// Window interface for Metacritic API exposure
declare global {
  interface Window {
    metacritic?: {
      getGameReviews: (gameName: string) => Promise<MetacriticGameResponse | null>;
      clearCache: () => Promise<boolean>;
    };
  }
}

export {};


