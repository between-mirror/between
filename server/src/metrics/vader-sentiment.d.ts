// Minimal typings for the untyped `vader-sentiment` package (NLTK VADER port).
declare module 'vader-sentiment' {
  export const SentimentIntensityAnalyzer: {
    polarity_scores(input: string): { neg: number; neu: number; pos: number; compound: number };
  };
}
